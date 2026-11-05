import test from "node:test";
import assert from "node:assert/strict";
import {
  askSideModel,
  countConversationMessages,
  formatFailure,
  resolveRoute,
  selectMessages,
  snapshotMessages,
  trimToolBoundary
} from "../lib/side-request.js";

const streamOf = (chunks) => ({
  async *stream(request) {
    this.request = request;
    for (const chunk of chunks) yield chunk;
  }
});

test("countConversationMessages ignores the system prompt and tool traffic", () => {
  const messages = [
    { role: "system", content: [] },
    { role: "user", content: [] },
    { role: "tool", content: [] },
    { role: "assistant", content: [] }
  ];
  assert.equal(countConversationMessages(messages), 2);
  assert.equal(countConversationMessages([]), 0);
  assert.equal(countConversationMessages(undefined), 0);
});

test("resolveRoute prefers the request header and falls back to the context event", () => {
  const fromHeader = resolveRoute({
    requestHeader: () => ({ config: { provider: "deepseek-official", model: "deepseek-flash", maxTokens: 256000 } }),
    requestContext: () => ({ provider: "other", model: "other" })
  });
  assert.equal(fromHeader.provider, "deepseek-official");
  assert.equal(fromHeader.model, "deepseek-flash");
  assert.equal(fromHeader.maxTokens, 256000);

  const fromContext = resolveRoute({ requestHeader: () => undefined, requestContext: () => ({ provider: "p", model: "m" }) });
  assert.equal(fromContext.provider, "p");
  assert.equal(fromContext.model, "m");
  assert.equal(resolveRoute(undefined).provider, undefined);
});

test("snapshotMessages tolerates a session without the reader", () => {
  assert.deepEqual(snapshotMessages({ deriveMessages: () => [{ role: "user" }] }), [{ role: "user" }]);
  assert.deepEqual(snapshotMessages({}), []);
  assert.deepEqual(snapshotMessages(undefined), []);
});

test("askSideModel joins text deltas and forwards the route", async () => {
  const llm = streamOf([
    { type: "text-delta", text: "hel" },
    { type: "reasoning-delta", text: "ignored" },
    { type: "text-delta", text: "lo" },
    { type: "finish", reason: { kind: "stop" } }
  ]);
  const answer = await askSideModel(llm, {
    provider: "deepseek-official",
    model: "deepseek-flash",
    messages: [{ role: "user", content: [] }],
    sessionId: "session-1",
    maxTokens: 100
  });
  assert.equal(answer, "hello");
  assert.equal(llm.request.provider, "deepseek-official");
  assert.equal(llm.request.model, "deepseek-flash");
  assert.equal(llm.request.sessionId, "session-1");
  assert.equal(llm.request.maxTokens, 100);
  assert.equal(Object.hasOwn(llm.request, "system"), false);
});

test("askSideModel surfaces stream errors and empty answers", async () => {
  const failed = streamOf([{ type: "finish", reason: { kind: "error", failure: new Error("boom") } }]);
  await assert.rejects(
    () => askSideModel(failed, { provider: "p", model: "m", messages: [] }),
    /boom/
  );

  const aborted = streamOf([{ type: "finish", reason: { kind: "aborted" } }]);
  await assert.rejects(() => askSideModel(aborted, { provider: "p", model: "m", messages: [] }), /aborted/);

  const empty = streamOf([{ type: "finish", reason: { kind: "stop" } }]);
  await assert.rejects(() => askSideModel(empty, { provider: "p", model: "m", messages: [] }), /no text/);

  await assert.rejects(() => askSideModel(undefined, { provider: "p", model: "m" }), /llm service/);
  await assert.rejects(() => askSideModel(streamOf([]), { model: "m" }), /provider and model/);
});

test("formatFailure turns an LlmFailure into a readable line", () => {
  assert.equal(
    formatFailure({ message: "context length exceeded", code: "CONTEXT_LENGTH_EXCEEDED", status: 400 }),
    "context length exceeded (CONTEXT_LENGTH_EXCEEDED) HTTP 400"
  );
  assert.equal(formatFailure("boom"), "boom");
  assert.equal(formatFailure(new Error("nope")), "nope");
  assert.equal(formatFailure(undefined), "side request failed");
});

test("trimToolBoundary drops a dangling tool call and keeps complete ones", () => {
  const pending = [
    { role: "user", content: [] },
    { role: "assistant", content: [{ type: "tool-call", id: "call-1" }] },
    { role: "tool", toolCallId: "other", content: [] }
  ];
  assert.deepEqual(trimToolBoundary(pending), [{ role: "user", content: [] }]);
  const complete = [
    { role: "user", content: [] },
    { role: "assistant", content: [{ type: "tool-call", id: "call-1" }] },
    { role: "tool", toolCallId: "call-1", content: [] }
  ];
  assert.equal(trimToolBoundary(complete), complete);
});

test("selectMessages keeps the system prompt, cuts from the front and strips images", () => {
  const messages = [
    { role: "system", content: [{ type: "text", text: "sys" }] },
    { role: "assistant", content: [{ type: "text", text: "orphan" }] },
    { role: "user", content: [{ type: "image", url: "blob:x" }, { type: "text", text: "look" }] },
    { role: "assistant", content: [{ type: "text", text: "seen" }] },
    { role: "user", content: [{ type: "text", text: "next" }] }
  ];
  const bounded = selectMessages(messages, { maxMessages: 3, maxChars: 10_000 });
  assert.equal(bounded.messages[0].role, "system");
  assert.equal(bounded.messages[1].role, "user");
  assert.deepEqual(bounded.messages[1].content[0], { type: "text", text: "[图片]" });
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.dropped, 1);
});

test("selectMessages stops on the character budget", () => {
  const big = (text) => ({ role: "user", content: [{ type: "text", text }] });
  const messages = [big("a".repeat(400)), { role: "assistant", content: [{ type: "text", text: "b".repeat(400) }] }, big("c".repeat(400))];
  const bounded = selectMessages(messages, { maxMessages: 10, maxChars: 700 });
  assert.equal(bounded.messages.length, 1);
  assert.equal(bounded.dropped, 2);
  assert.equal(bounded.truncated, true);
});
