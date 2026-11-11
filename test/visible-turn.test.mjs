import test from "node:test";
import assert from "node:assert/strict";
import { openVisibleTurn } from "../lib/visible-turn.js";

/**
 * A Cordis-shaped host: `on` returns a disposer and named listeners can be
 * emitted or driven as a waterfall.
 */
const makeHost = () => {
  const listeners = new Map();
  const ctx = {
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(listener);
      return () => listeners.get(name)?.delete(listener);
    }
  };
  const listOf = (name) => [...(listeners.get(name) ?? [])];
  return {
    ctx,
    listeners,
    count: (name) => listOf(name).length,
    emit(name, ...args) {
      for (const listener of listOf(name)) listener(...args);
    },
    async waterfall(name, payload) {
      const run = async (index) => {
        const listener = listOf(name)[index];
        if (listener === undefined) return undefined;
        return listener(payload, () => run(index + 1));
      };
      return run(0);
    }
  };
};

const makeAgent = (id) => ({
  id,
  queued: [],
  inbox: {
    append(target, message) {
      this.owner.queued.push({ target, message });
    }
  }
});

/** A controller whose `prompt` runs one empty turn through the host hooks. */
const makeController = ({ host, agent, message, turn = 1, targetId = agent.id }) => ({
  requests: [],
  decision: undefined,
  prompt(request) {
    this.requests.push(request);
    queueMicrotask(async () => {
      this.decision = await host.waterfall("agent/pre-step", {
        agent,
        messages: [message],
        turn,
        step: 1,
        signal: new AbortController().signal
      });
      host.emit("session/event", { id: targetId }, { type: "turn/end", data: { turn } });
    });
    return Promise.resolve({ accepted: true });
  }
});

const briefMessage = (id = "msg-1") => ({
  id,
  role: "user",
  content: [{ type: "text", text: "brief" }],
  source: { kind: "user" }
});

test("the loop closes an empty turn and the brief stays queued for the next step", async () => {
  const host = makeHost();
  const agent = makeAgent("session-a");
  agent.inbox.append = agent.inbox.append.bind({ owner: agent });
  const controller = makeController({ host, agent, message: briefMessage() });

  const result = await openVisibleTurn({ ctx: host.ctx, controller, sessionId: "session-a", text: "brief" });

  assert.deepEqual(result, { opened: true, requeued: 1 });
  assert.equal(controller.requests.length, 1);
  assert.equal(controller.requests[0].mode, "queue");
  assert.equal(controller.requests[0].content[0].text, "brief");
  assert.deepEqual(controller.decision, { kind: "enter", messages: [] });
  assert.deepEqual(agent.queued, [{ target: "next-step", message: briefMessage() }]);
  assert.equal(host.count("agent/pre-step"), 0, "the one-shot hook must unhook itself");
  assert.equal(host.count("session/event"), 0, "the turn listener must be released");
});

test("another session's pre-step and turns pass through untouched", async () => {
  const host = makeHost();
  const foreign = makeAgent("session-a");
  let nextCalls = 0;
  const listener = async ({ message }, next) => {
    nextCalls += 1;
    return next();
  };
  host.ctx.on("agent/pre-step", listener);
  const controller = makeController({
    host,
    agent: foreign,
    message: briefMessage("foreign"),
    targetId: "session-b"
  });

  const result = await openVisibleTurn({
    ctx: host.ctx,
    controller,
    sessionId: "session-b",
    text: "brief"
  });

  // The pre-step hook saw session-a's agent while watching session-b: it must
  // fall through to the next listener instead of hijacking that turn.
  assert.equal(result.opened, true);
  assert.equal(result.requeued, 0);
  assert.ok(nextCalls >= 1);
  assert.equal(controller.decision, undefined);
  assert.deepEqual(foreign.queued, []);
  assert.equal(host.count("agent/pre-step"), 1, "only the unrelated test listener is left");
});

test("a turn that never closes is reported without hanging", async () => {
  const host = makeHost();
  const agent = makeAgent("session-a");
  const controller = { prompt: () => Promise.resolve({ accepted: true }), requests: [] };

  const result = await openVisibleTurn({
    ctx: host.ctx,
    controller,
    sessionId: "session-a",
    text: "brief",
    timeoutMs: 5
  });

  assert.equal(result.opened, false);
  assert.equal(result.reason, "turn-not-closed");
  assert.equal(host.count("agent/pre-step"), 1, "an in-flight turn keeps its surface hook");
});

test("a rejected prompt releases every listener", async () => {
  const host = makeHost();
  const controller = {
    prompt: () => Promise.reject(new Error("session/agent-busy"))
  };

  await assert.rejects(
    openVisibleTurn({ ctx: host.ctx, controller, sessionId: "session-a", text: "brief" }),
    /agent-busy/
  );
  assert.equal(host.count("agent/pre-step"), 0);
  assert.equal(host.count("session/event"), 0);
});
