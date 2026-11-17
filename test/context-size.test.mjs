import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONTEXT_WINDOW,
  REFUSE_RATIO,
  WARN_RATIO,
  contextRatio,
  describeMeasure,
  measureContext,
  percent,
  readContextWindow
} from "../lib/context-size.js";

test("a text-only snapshot is measured with a CJK-aware weighting", () => {
  const measure = measureContext([
    { role: "user", content: [{ type: "text", text: "交接" }] },
    { role: "assistant", content: [{ type: "text", text: "handoff" }] }
  ]);

  assert.equal(measure.textTokens, 2 + Math.ceil(7 * 0.3));
  assert.equal(measure.images, 0);
  assert.equal(measure.approxTokens, measure.textTokens);
});

test("images count as their vision budget, not as their base64 length", () => {
  const measure = measureContext([
    { role: "user", content: [{ type: "image", attachment: { width: 1500, height: 750 } }] }
  ]);

  assert.equal(measure.images, 1);
  assert.equal(measure.imageTokens, 1500);
  assert.equal(measure.approxTokens, 1500);
});

test("an image without dimensions falls back to a fixed budget", () => {
  const measure = measureContext([{ role: "user", content: [{ type: "image" }] }]);
  assert.equal(measure.images, 1);
  assert.equal(measure.imageTokens, 1600);
});

test("nested tool blocks are visited once each", () => {
  const measure = measureContext([
    { role: "assistant", content: [{ type: "tool-call", arguments: { text: "忽略我" } }] },
    { role: "tool", content: [{ type: "text", text: "结果" }] }
  ]);
  // Only the real text block counts: tool arguments are not conversation text.
  assert.equal(measure.textTokens, 2);
});

test("the window comes from the request context, else the guard floor", () => {
  assert.equal(readContextWindow({ requestContext: () => ({ contextWindow: 2_000_000 }) }), 2_000_000);
  assert.equal(readContextWindow({ requestContext: () => undefined }), DEFAULT_CONTEXT_WINDOW);
  assert.equal(readContextWindow({}), DEFAULT_CONTEXT_WINDOW);
  assert.equal(readContextWindow({ requestContext: () => ({ contextWindow: 0 }) }), DEFAULT_CONTEXT_WINDOW);
});

test("ratio, percentage and the human description add up", () => {
  const measure = { textTokens: 1_200_000, imageTokens: 1_600_000, images: 977, approxTokens: 2_800_000 };
  assert.equal(contextRatio(measure, 1_000_000), 2.8);
  assert.equal(percent(2.8), "280%");
  const text = describeMeasure(measure, 1_000_000);
  assert.ok(text.includes("2,800,000"));
  assert.ok(text.includes("977"));
  assert.ok(text.includes("窗口 1,000,000"));
  assert.ok(REFUSE_RATIO > WARN_RATIO);
});

test("an empty snapshot measures zero", () => {
  const measure = measureContext([]);
  assert.deepEqual(measure, { textTokens: 0, imageTokens: 0, images: 0, approxTokens: 0 });
  assert.equal(contextRatio(measure, 0), 0);
});
