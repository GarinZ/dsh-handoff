/**
 * Prompt text for the handoff brief — pure strings, no host services.
 *
 * The same rules serve two callers:
 *   - the tool path, where the main model writes the brief straight into the
 *     `handoff_session` argument (see the tool's `summary` description), and
 *   - the side-request path, where a `/handoff` command snapshots the session
 *     and asks the model for the brief out of band, with no agent turn and no
 *     event written into the conversation.
 *
 * Benchmarked against oh-my-pi's `handoff-document.md` and pi-handoff's
 * `HANDOFF_INSTRUCTIONS`: fixed skeleton, "state not narrative", no invention,
 * imperatives instead of first person, and the mechanism invisible to the
 * document.
 */

/** Section headings every brief carries, in order. */
export const BRIEF_SECTIONS = ["目标", "决策", "已完成", "剩余", "关键上下文", "下一步"];

const MODE_RULES = {
  full:
    "Mode: full — the next session already has this conversation's complete transcript. Keep the brief compact (a few hundred words) and do not restate what the transcript shows; spend the words on decisions, pitfalls, and what to do next.",
  summary:
    "Mode: summary — the next session receives NOTHING but this brief. It must stand on its own: name the files to reopen, the conclusions to re-confirm, and the exact next action."
};

function modeRule(history) {
  return history === "summary" ? MODE_RULES.summary : MODE_RULES.full;
}

/** Prompt for one out-of-band brief generation over a session snapshot. */
export function buildBriefPrompt({ request = "", history = "full" } = {}) {
  const focus = String(request ?? "").trim() === ""
    ? "(no extra request — write a complete brief following the structure)"
    : String(request).trim();
  return [
    "<critical>",
    "You are the previous instance of this conversation. Write a handoff brief for the next instance.",
    "The next instance cannot see this conversation. Do not address the user; address the next instance.",
    "Output ONLY the brief: no preamble, no commentary, no restating the conversation.",
    "</critical>",
    "",
    "<rules>",
    "- Use only facts that appear in this conversation. Never invent paths, line numbers, commands, outputs, or conclusions.",
    "- If a critical detail is unknown, say so in one line and give the smallest step to verify it.",
    "- Address the next instance directly in the imperative (\"Fix X\", \"Run Y\"), never in first person.",
    "- Never list writing this brief or performing the handoff as progress or as a next step; progress and next steps cover the user's task only.",
    "- Be specific: file paths, symbols, commands run, test results, error messages, config values.",
    "- Prefer what the next instance cannot re-derive cheaply; omit history and retrospective narrative.",
    "- Write the brief in the user's language.",
    `- ${modeRule(history)}`,
    "- The user's request below says where to hand off and what to emphasize; honor the emphasis.",
    "</rules>",
    "",
    "<request>",
    focus,
    "</request>",
    "",
    "<output>",
    "Use exactly these headings, in this order, and keep them even when a section is empty (write 无 / none):",
    "## 目标",
    "## 决策",
    "## 已完成",
    "## 剩余",
    "## 关键上下文",
    "## 下一步",
    "</output>"
  ].join("\n");
}

/** System prompt for the `/btw` side question. */
export const BTW_SYSTEM_PROMPT = [
  "You answer a side question about an ongoing coding session.",
  "The conversation above is the user's real session; you are a read-only observer.",
  "Answer in the user's language: direct, concise, and grounded in what the session shows.",
  "Quote or name the relevant messages when they decide the answer.",
  "If the session does not contain the answer, say so plainly instead of guessing.",
  "Do not call tools and do not modify anything; you cannot take actions."
].join("\n");

/** Instruction the fallback path enqueues for the main model. */
export function buildInstructionText({ request = "", history = "full" } = {}) {
  const focus = String(request ?? "").trim();
  const modeLine = history === "full" ? "full — 复制完整历史" : "summary — 只写总结，不复制历史";
  return [
    "【Handoff 请求】用户在斜杠命令后写了一段自然语言要求，它同时说明了要交接去哪里、以及简报该重点写什么：",
    "----",
    focus.length > 0 ? focus : "（用户没有写具体要求：请根据这次对话判断最合适的目标工作区；实在判断不出来就问用户。）",
    "----",
    `交接模式：${modeLine}。`,
    "",
    "请按三步执行：",
    "1. 确定目标工作区：从上面这段话里读出来的地点优先；没写就结合对话内容和现有工作区挑最合适的一个；仍然无法确定时用 ask_user_question 问用户，不要猜。target 可以是绝对路径（或 ~ 开头）、工作区标题、或工作区 id。",
    "2. 写交接简报：严格用六节——## 目标 / ## 决策（每条写明理由）/ ## 已完成（带文件、命令、测试结果）/ ## 剩余 / ## 关键上下文（路径、符号、报错原文）/ ## 下一步；用户在上面点名的重点必须写进去。",
    "3. 调用 handoff_session：target 用第 1 步的结果，history 用上面的模式，summary 用第 2 步的简报；用户提到标题或是否立即开跑时，再传 title / start_turn。",
    history === "summary"
      ? "summary 模式下简报是新会话唯一的信息来源：必须自包含，写明要重开哪些文件、重新确认哪些结论。"
      : "如果这次对话已经很长、或上下文压缩失败过，提醒用户可以改用 /handoff-summary，免得新会话继承同样的上下文压力。"
  ].join("\n");
}
