import test from "node:test";
import assert from "node:assert/strict";
import { apply, inject, name } from "../index.js";

/** Minimal host context: enough services for apply() to register its surface. */
const makeHost = () => {
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

test("apply registers one tool and both slash commands", () => {
  const host = makeHost();
  apply(host.ctx);
  assert.equal(host.tools.length, 1);
  assert.equal(host.tools[0].name, "handoff_session");
  assert.deepEqual(host.commands.map((command) => command.name).sort(), ["handoff", "handoff-summary"]);
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
