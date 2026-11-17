import test from "node:test";
import assert from "node:assert/strict";
import { BRIEF_SECTIONS, BTW_SYSTEM_PROMPT, buildBriefPrompt } from "../lib/prompts.js";

test("the skeleton is the fixed six sections, in order", () => {
  assert.deepEqual(BRIEF_SECTIONS, ["目标", "决策", "已完成", "剩余", "关键上下文", "下一步"]);
});

test("the brief prompt carries every section heading", () => {
  const prompt = buildBriefPrompt({ request: "交接到 ~/repo", history: "full" });
  for (const section of BRIEF_SECTIONS) {
    assert.ok(prompt.includes(`## ${section}`), `missing section ${section}`);
  }
  assert.ok(prompt.includes("交接到 ~/repo"), "the user request is injected verbatim");
});

test("the brief prompt states the anti-fabrication and no-meta rules", () => {
  const prompt = buildBriefPrompt({ request: "x", history: "full" });
  assert.ok(prompt.includes("Never invent"));
  assert.ok(prompt.includes("smallest step to verify"));
  assert.ok(prompt.includes("never in first person"));
  assert.ok(prompt.includes("Never list writing this brief"));
  assert.ok(prompt.includes("Output ONLY the brief"));
});

test("summary and full modes say different things about the transcript", () => {
  const summary = buildBriefPrompt({ request: "x", history: "summary" });
  const full = buildBriefPrompt({ request: "x", history: "full" });
  assert.ok(summary.includes("NOTHING but this brief"));
  assert.ok(summary.includes("stand on its own"));
  assert.ok(full.includes("complete transcript"));
  assert.ok(full.includes("compact"));
  assert.notEqual(summary, full);
});

test("an empty request still asks for a complete brief", () => {
  const prompt = buildBriefPrompt({ request: "   ", history: "full" });
  assert.ok(prompt.includes("no extra request"));
});

test("the btw system prompt keeps the observer read-only", () => {
  assert.ok(BTW_SYSTEM_PROMPT.includes("read-only"));
  assert.ok(BTW_SYSTEM_PROMPT.includes("Do not call tools"));
});
