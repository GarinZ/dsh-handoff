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
  const listeners = [];
  const ctx = {
    logger: { warn() {}, info() {}, error() {} },
    tools: { register: (tool) => { tools.push(tool); return () => {}; } },
    on: (eventName, listener) => { if (eventName === "session/event") listeners.push(listener); return () => {}; },
    get: (key, fallback) => {
      if (key === "commands") {
        return { register: (definition) => { commands.push(definition); return () => {}; } };
      }
      if (Object.hasOwn(services, key)) return services[key];
      if (key === "sessionController") return { prompt: async (request) => { prompts.push(request); } };
      return fallback;
    }
  };
  const emit = (session, event) => {
    for (const listener of listeners) listener(session, event);
  };
  return { ctx, tools, commands, prompts, emit };
};

/** Let the scheduled side request settle before the test inspects the result. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

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

test("/btw answers over a snapshot without prompting the agent", async () => {
  const llm = fakeLlm("这个仓库用的是 MIT 许可证。");
  const host = makeHost({ llm });
  apply(host.ctx);
  const btw = findCommand(host.commands, "btw");
  const appended = [];
  const session = fakeSession({ append: (type, data) => { appended.push({ type, data }); return { type, data }; } });
  const agent = { id: "session-abc", session };
  const result = await btw.handler({ agent, rawInput: "这个仓库用什么许可证？", commandId: "cmd-1", signal: undefined });

  assert.equal(result.kind, "success");
  assert.ok(result.text.startsWith("旁问中"), "the handler must return at once so the composer clears");
  assert.equal(host.prompts.length, 0, "no agent turn may be queued");
  assert.equal(llm.calls.length, 1);
  const [call] = llm.calls;
  assert.equal(call.provider, "deepseek-official");
  assert.equal(call.model, "deepseek-flash");
  assert.equal(call.sessionId, "session-abc");
  // The request is flattened: rules go in `system`, the transcript and the
  // question travel as one user message (structured history is what providers
  // reject when no tools are declared).
  assert.equal(call.messages.length, 1);
  const last = call.messages[0];
  assert.equal(last.role, "user");
  const prompt = last.content[0].text;
  assert.ok(prompt.includes("这个仓库用什么许可证？"));
  assert.ok(prompt.includes("<conversation>"));
  assert.ok(prompt.includes("do the work"), "the transcript carries the conversation");
  assert.ok(call.system.includes("<critical>") || call.system.length > 0, "the btw rules travel as the system prompt");

  // The executor settles first; the answer then replaces the placeholder node.
  await settle();
  host.emit(session, { type: "command/done", data: { commandId: "cmd-1", kind: "success", text: result.text } });
  const late = appended.at(-1);
  assert.equal(late.type, "command/done");
  assert.equal(late.data.commandId, "cmd-1");
  assert.equal(late.data.kind, "success");
  assert.equal(late.data.text, "这个仓库用的是 MIT 许可证。");
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

test("the handoff command returns at once and reports the background failure later", async () => {
  const llm = fakeLlm("## 目标\nbrief");
  const host = makeHost({
    llm,
    workspaceRegistry: { list: () => [], create: async () => { throw new Error("没有可用的工作区工厂"); } },
    sessionController: { prompt: async () => { throw new Error("the model path must not run"); } }
  });
  apply(host.ctx);
  const appended = [];
  const session = fakeSession({ append: (type, data) => { appended.push({ type, data }); return { type, data }; } });
  const command = findCommand(host.commands, "handoff");
  const result = await command.handler({
    agent: { id: "session-abc", session },
    rawInput: "交接给 /tmp，重点写测试",
    commandId: "cmd-2",
    signal: undefined
  });

  assert.equal(result.kind, "success");
  assert.ok(result.text.startsWith("正在生成简报并交接"), "the handler must return before the side request finishes");
  assert.equal(host.prompts.length, 0, "the fast path must not queue a model turn");

  host.emit(session, { type: "command/done", data: { commandId: "cmd-2", kind: "success", text: result.text } });
  const deadline = Date.now() + 2_000;
  while (appended.length === 0 && Date.now() < deadline) await settle();
  const late = appended.at(-1);
  assert.equal(late?.type, "command/done");
  assert.equal(late.data.commandId, "cmd-2");
  assert.equal(late.data.kind, "error");
  assert.ok(late.data.text.length > 0, "the failure must be reported in the command node");
});

test("/btw remembers earlier side answers so a follow-up can build on them", async () => {
  const llm = fakeLlm("第一问的答案。");
  const host = makeHost({ llm });
  apply(host.ctx);
  const btw = findCommand(host.commands, "btw");
  const session = fakeSession({ append: () => ({}) });
  const agent = { id: "session-abc", session };

  await btw.handler({ agent, rawInput: "第一步是什么？", commandId: "cmd-1", signal: undefined });
  await settle();
  host.emit(session, { type: "command/done", data: { commandId: "cmd-1", kind: "success", text: "占位" } });

  await btw.handler({ agent, rawInput: "那第二步呢？", commandId: "cmd-2", signal: undefined });
  const prompt = llm.calls.at(-1).messages[0].content[0].text;
  assert.ok(prompt.includes("<earlier-side-questions>"), "the second question carries the first Q&A");
  assert.ok(prompt.includes("第一步是什么？"));
  assert.ok(prompt.includes("第一问的答案。"));
  assert.ok(prompt.includes("<question>\n那第二步呢？"));
});

test("side answers reach a follow-up in full, not clipped", async () => {
  const long = "长答案".repeat(2000);
  const llm = fakeLlm(long);
  const host = makeHost({ llm });
  apply(host.ctx);
  const btw = findCommand(host.commands, "btw");
  const session = fakeSession({ append: () => ({}) });
  const agent = { id: "session-abc", session };

  await btw.handler({ agent, rawInput: "第一问", commandId: "cmd-1", signal: undefined });
  await settle();
  host.emit(session, { type: "command/done", data: { commandId: "cmd-1", kind: "success", text: "占位" } });
  await btw.handler({ agent, rawInput: "追问", commandId: "cmd-2", signal: undefined });

  const prompt = llm.calls.at(-1).messages[0].content[0].text;
  assert.ok(prompt.includes(long), "the earlier answer is carried verbatim");
  assert.ok(!prompt.includes("…\n"), "no ellipsis marker");
});
