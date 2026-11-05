/**
 * Side request: one extra model call over a snapshot of the live session.
 *
 * Same primitive as the BTW plugins in the market (`dsh-btw-plugin`,
 * `dsh-command-btw`): take the session's frozen message snapshot, append one
 * user message, call `ctx.llm.stream()` once, and return the text. No agent is
 * created, no event is written, the answer never enters the conversation.
 *
 * Used by `/handoff` and `/handoff-summary` to generate the brief out of band
 * and by `/btw` to answer a side question.
 */

/**
 * Route for the side request, taken from the session's most recent request
 * header (falling back to the request context event).
 * @returns {{provider?: string, model?: string, reasoningEffort?: string, maxTokens?: number}}
 */
export function resolveRoute(session) {
  const config = session?.requestHeader?.()?.config ?? {};
  const context = session?.requestContext?.() ?? {};
  return {
    provider: config.provider ?? context.provider,
    model: config.model ?? context.model,
    reasoningEffort: config.reasoningEffort,
    maxTokens: config.maxTokens
  };
}

/** Frozen message snapshot of the session (includes the system prompt). */
export function snapshotMessages(session) {
  const messages = session?.deriveMessages?.();
  return Array.isArray(messages) ? messages : [];
}

/** Count messages the user and the assistant actually produced. */
export function countConversationMessages(messages) {
  let count = 0;
  for (const message of messages ?? []) {
    const role = message?.role;
    if (role === "user" || role === "assistant") count += 1;
  }
  return count;
}

/**
 * Render a provider failure so the card and the command result carry something
 * readable. `LlmFailure` is `{ message, code, status? }` — not an Error.
 */
export function formatFailure(failure) {
  if (failure === undefined || failure === null) return "side request failed";
  if (typeof failure === "string") return failure;
  if (failure instanceof Error) return failure.message || String(failure);
  const parts = [];
  if (typeof failure.message === "string" && failure.message.length > 0) parts.push(failure.message);
  if (typeof failure.code === "string" && failure.code.length > 0) parts.push(`(${failure.code})`);
  if (typeof failure.status === "number") parts.push(`HTTP ${failure.status}`);
  return parts.length > 0 ? parts.join(" ") : JSON.stringify(failure).slice(0, 400);
}

const IMAGE_TYPES = new Set(["image", "image-url", "image-ref"]);

/** Replace image blocks with a text placeholder: a side request never needs pixels. */
export function stripImages(message) {
  if (!Array.isArray(message?.content)) return message;
  let changed = false;
  const content = message.content.map((block) => {
    if (block && IMAGE_TYPES.has(block.type)) {
      changed = true;
      return { type: "text", text: "[图片]" };
    }
    return block;
  });
  return changed ? { ...message, content } : message;
}

const ROLE_LABELS = { user: "用户", assistant: "助手", tool: "工具结果" };

const textOf = (content) => (Array.isArray(content) ? content : [])
  .filter((block) => block && block.type === "text" && typeof block.text === "string")
  .map((block) => block.text)
  .join("\n");

/**
 * Flatten a session snapshot into a plain-text transcript.
 *
 * Side requests send text, never the structured history: tool-call blocks,
 * image parts and role ordering are exactly what a provider rejects on a
 * request that declares no tools, which is why the market BTW plugins flatten
 * too. Newest entries win the budget; older ones are dropped whole.
 */
export function buildTranscript(messages, options = {}) {
  const maxChars = Number.isFinite(options.maxChars) ? options.maxChars : 200_000;
  const toolChars = Number.isFinite(options.toolChars) ? options.toolChars : 200;
  const entries = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== "object") continue;
    const role = message.role;
    if (role === "user" || role === "tool") {
      const text = textOf(message.content).trim();
      if (text.length > 0) entries.push({ role, text });
      continue;
    }
    if (role !== "assistant") continue;
    const parts = [];
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
      else if (IMAGE_TYPES.has(block.type)) parts.push("[图片]");
      else if (block.type === "tool-call" && typeof block.name === "string") {
        const args = typeof block.arguments === "string" ? block.arguments : "";
        const shown = toolChars > 0 && args.length > toolChars ? `${args.slice(0, toolChars)}…` : toolChars === 0 ? "" : args;
        parts.push(shown.length > 0 ? `[调用工具 ${block.name}] ${shown}` : `[调用工具 ${block.name}]`);
      }
    }
    const text = parts.join("\n").trim();
    if (text.length > 0) entries.push({ role: "assistant", text });
  }

  const kept = [];
  let used = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (used + entry.text.length > maxChars) break;
    used += entry.text.length;
    kept.unshift(entry);
  }
  const dropped = entries.length - kept.length;
  const head = dropped > 0 ? `（更早的 ${dropped} 条消息已省略）` : "";
  const body = kept.map((entry) => `## ${ROLE_LABELS[entry.role]}\n${entry.text}`).join("\n\n");
  return { text: [head, body].filter((part) => part.length > 0).join("\n\n"), dropped, truncated: dropped > 0 };
}

/**
 * One-shot side request.
 * @param {object} llm - `ctx.llm`
 * @param {object} options
 * @param {string} options.provider
 * @param {string} options.model
 * @param {object[]} options.messages - full message list, system prompt first
 * @param {string} [options.system] - extra system text for this request only
 * @param {string} [options.sessionId]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.maxTokens]
 * @param {number} [options.temperature]
 * @param {(text: string) => void} [options.onDelta] - called with the accumulated
 *   text as it streams, so a progress channel can mirror the answer live
 * @returns {Promise<{text: string, finishKind?: string}>}
 */
export async function askSideModel(llm, options) {
  if (llm === undefined || typeof llm?.stream !== "function") {
    throw new Error("side request needs the llm service");
  }
  if (typeof options.provider !== "string" || typeof options.model !== "string") {
    throw new Error("side request needs provider and model from the session header");
  }

  let text = "";
  let finish;
  const request = {
    provider: options.provider,
    model: options.model,
    messages: options.messages,
    sessionId: options.sessionId,
    signal: options.signal
  };
  if (options.system !== undefined) request.system = options.system;
  if (options.maxTokens !== undefined) request.maxTokens = options.maxTokens;
  if (options.temperature !== undefined) request.temperature = options.temperature;

  for await (const chunk of llm.stream(request)) {
    switch (chunk?.type) {
      case "text-delta":
        text += chunk.text;
        options.onDelta?.(text);
        break;
      case "finish":
        finish = chunk.reason;
        break;
      default:
        break;
    }
  }

  if (finish?.kind === "error") {
    const failure = finish.failure;
    const error = new Error(formatFailure(failure));
    if (failure && typeof failure === "object") {
      if (typeof failure.code === "string") error.code = failure.code;
      if (typeof failure.status === "number") error.status = failure.status;
    }
    throw error;
  }
  if (finish?.kind === "aborted") throw new Error("side request was aborted");

  const answer = text.trim();
  if (answer.length === 0) throw new Error("side request produced no text");
  // The caller gets the stop reason too: a `max-tokens` finish looks exactly
  // like a finished answer, and a silently cut brief is worse than a marked one.
  return { text: answer, finishKind: finish?.kind };
}
