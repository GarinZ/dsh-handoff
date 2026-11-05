import test from "node:test";
import assert from "node:assert/strict";
import { apply, inject, name } from "../index.js";

/**
 * Minimal host context: enough services for apply() to register its surface.
 * `services` overrides specific `ctx.get` lookups (llm, workspaceRegistry, …).
 */
const makeHost = (services = {}) => {
  const tools = [];
  const commands = [];
  const prompts = [];
  const ctx = {
    logger: { warn() {}, info() {}, error() {} },
    tools: { register: (tool) => { tools.push(tool); return () => {}; } },
    on: () => () => {},
    get: (key, fallback) => {
      if (key === "commands") {
        return { register: (definition) => { commands.push(definition); return () => {}; } };
      }
      if (Object.hasOwn(services, key)) return services[key];
      if (key === "sessionController") return { prompt: async (request) => { prompts.push(request); } };
      return fallback;
    }
  };
  return { ctx, tools, commands, prompts };
};

const findCommand = (commands, commandName) => {
  const found = commands.find((command) => command.name === commandName);
  assert.ok(found, `command ${commandName} should be registered`);
  return found;
};

/** A fake llm service that streams one canned answer. */
const fakeLlm = (answer) => {
  const calls = [];
  return {
    calls,
    async *stream(request) {
      calls.push(request);
      yield { type: "text-delta", text: answer };
      yield { type: "finish", reason: { kind: "stop" } };
    }
  };
};

/** A live-session stand-in with the two header readers the plugin uses. */
const fakeSession = (overrides = {}) => ({
  id: "session-abc",
  requestHeader: () => ({ config: { provider: "deepseek-official", model: "deepseek-flash" } }),
  requestContext: () => undefined,
  deriveMessages: () => [
    { role: "system", content: [{ type: "text", text: "system" }] },
    { role: "user", content: [{ type: "text", text: "do the work" }] },
    { role: "assistant", content: [{ type: "text", text: "done" }] }
  ],
  ...overrides
});

test("apply registers one tool and three slash commands", () => {
  const host = makeHost();
  apply(host.ctx);
  assert.equal(host.tools.length, 1);
  assert.equal(host.tools[0].name, "handoff_session");
  assert.deepEqual(host.commands.map((command) => command.name).sort(), ["btw", "handoff", "handoff-summary"]);
  assert.equal(name, "dsh-handoff");
  assert.ok(inject.includes("sessions"));
});

test("a slash command queues a natural-language handoff request for the model", async () => {
  const host = makeHost();
  apply(host.ctx);
  const summary = findCommand(host.commands, "handoff-summary");
  const request = "交接给 agent-skills 那个仓库，重点写「别自动入库」这条约束";
  const result = await summary.handler({ agent: { id: "session-abc" }, rawInput: ` ${request} `, signal: undefined });

  assert.equal(result.kind, "success");
  assert.equal(host.prompts.length, 1);
  const [prompt] = host.prompts;
  assert.equal(prompt.sessionId, "session-abc");
  assert.equal(prompt.mode, "queue");
  assert.equal(typeof prompt.requestId, "string");
  const text = prompt.content[0].text;
  assert.ok(text.includes(request), "the raw request must reach the model verbatim");
  assert.ok(text.includes("summary — 只写总结"), "the mode line must name the summary policy");
  assert.ok(!text.includes("full — 复制完整历史"), "the summary command must not name the full policy");
});

test("the full command requests a full copy and lets the model pick the target", async () => {
  const host = makeHost();
  apply(host.ctx);
  const full = findCommand(host.commands, "handoff");
  const result = await full.handler({ agent: { id: "session-xyz" }, rawInput: "~/work/another-repo", signal: undefined });

  assert.equal(result.kind, "success");
  const text = host.prompts[0].content[0].text;
  assert.ok(text.includes("full — 复制完整历史"));
  assert.ok(text.includes("~/work/another-repo"));
});

test("an empty command falls back to asking the model to choose a target", async () => {
  const host = makeHost();
  apply(host.ctx);
  const command = findCommand(host.commands, "handoff");
  const result = await command.handler({ agent: { id: "session-abc" }, rawInput: "   ", signal: undefined });

  assert.equal(result.kind, "success");
  const text = host.prompts[0].content[0].text;
  assert.ok(text.includes("用户没有写具体要求"));
});

test("a missing session controller is reported instead of thrown", async () => {
  const tools = [];
  const commands = [];
  const ctx = {
    logger: { warn() {} },
    tools: { register: (tool) => { tools.push(tool); return () => {}; } },
    on: () => () => {},
    get: (key, fallback) => {
      if (key === "commands") return { register: (definition) => { commands.push(definition); return () => {}; } };
      return undefined;
    }
  };
  apply(ctx);
  const result = await findCommand(commands, "handoff").handler({ agent: { id: "session-abc" }, rawInput: "x", signal: undefined });
  assert.equal(result.kind, "error");
  assert.ok(result.text.includes("会话控制器不可用"));
});

test("/btw answers over a snapshot and returns the text without prompting the agent", async () => {
  const llm = fakeLlm("这个仓库用的是 MIT 许可证。");
  const host = makeHost({ llm });
  apply(host.ctx);
  const btw = findCommand(host.commands, "btw");
  const agent = { id: "session-abc", session: fakeSession() };
  const result = await btw.handler({ agent, rawInput: "这个仓库用什么许可证？", signal: undefined });

  assert.equal(result.kind, "success");
  assert.equal(result.text, "这个仓库用的是 MIT 许可证。");
  assert.equal(host.prompts.length, 0, "no agent turn may be queued");
  assert.equal(llm.calls.length, 1);
  const [call] = llm.calls;
  assert.equal(call.provider, "deepseek-official");
  assert.equal(call.model, "deepseek-flash");
  assert.equal(call.sessionId, "session-abc");
  const last = call.messages.at(-1);
  assert.equal(last.role, "user");
  assert.ok(last.content[0].text.includes("这个仓库用什么许可证？"));
  assert.ok(call.messages.some((message) => message.role === "system"), "the session system prompt is forwarded");
});

test("/btw without the llm service reports an error", async () => {
  const host = makeHost();
  apply(host.ctx);
  const result = await findCommand(host.commands, "btw").handler({
    agent: { id: "session-abc", session: fakeSession() },
    rawInput: "hi",
    signal: undefined
  });
  assert.equal(result.kind, "error");
  assert.ok(result.text.includes("llm"));
});

test("/btw with an empty question returns usage", async () => {
  const host = makeHost({ llm: fakeLlm("x") });
  apply(host.ctx);
  const result = await findCommand(host.commands, "btw").handler({ agent: { id: "s", session: fakeSession() }, rawInput: "  ", signal: undefined });
  assert.equal(result.kind, "error");
  assert.ok(result.text.includes("用法"));
});
