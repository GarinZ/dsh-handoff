import test from "node:test";
import assert from "node:assert/strict";
import { askSideModel, countConversationMessages, resolveRoute, snapshotMessages } from "../lib/side-request.js";

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
