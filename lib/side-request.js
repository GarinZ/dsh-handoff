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

/**
 * Drop a trailing assistant tool-call whose tool results have not been logged
 * yet: a frozen history must never be mutated, so a shortened array is returned
 * when trimming happens. Ported from ds-bot (via `dsh-btw-plugin`), the same
 * boundary the market BTW plugins send.
 */
export function trimToolBoundary(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  let index = messages.length;
  while (index > 0 && messages[index - 1]?.role === "tool") index -= 1;
  if (index === 0 || index === messages.length) return messages;
  const previous = messages[index - 1];
  const calls = (Array.isArray(previous?.content) ? previous.content : [])
    .filter((block) => block && block.type === "tool-call")
    .map((block) => block.id);
  if (calls.length === 0) return messages;
  const results = new Set(messages.slice(index).map((message) => message?.toolCallId));
  return calls.every((id) => results.has(id)) ? messages : messages.slice(0, index - 1);
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

const sizeOf = (message) => {
  try {
    return JSON.stringify(message).length;
  } catch {
    return 0;
  }
};

/**
 * Bound a session snapshot for one side request.
 *
 * A long session cannot be replayed in full: the provider rejects it, and even
 * when it fits it costs a fortune. Keep the system prompt, then the newest
 * messages that fit both budgets, and never start the window on tool traffic or
 * an assistant turn (providers require the first non-system message to be a
 * user message).
 *
 * @param {ReadonlyArray<object>} messages
 * @param {{maxMessages?: number, maxChars?: number}} [options]
 * @returns {{messages: object[], dropped: number, truncated: boolean}}
 */
export function selectMessages(messages, options = {}) {
  const maxMessages = Number.isFinite(options.maxMessages) ? options.maxMessages : 200;
  const maxChars = Number.isFinite(options.maxChars) ? options.maxChars : 300_000;
  const all = Array.isArray(messages) ? messages : [];
  const system = all.length > 0 && all[0]?.role === "system" ? stripImages(all[0]) : undefined;
  const body = (system ? all.slice(1) : all).map(stripImages);

  let selected = body.slice(-maxMessages);
  let dropped = body.length - selected.length;

  const trimFront = () => {
    while (selected.length > 0 && selected[0]?.role !== "user") {
      selected = selected.slice(1);
      dropped += 1;
    }
  };
  trimFront();
  selected = trimToolBoundary(selected);
  trimFront();

  let budget = maxChars - (system ? sizeOf(system) : 0);
  let used = selected.reduce((total, message) => total + sizeOf(message), 0);
  while (used > budget && selected.length > 1) {
    used -= sizeOf(selected[0]);
    selected = selected.slice(1);
    dropped += 1;
    trimFront();
  }

  const trimmed = [...(system ? [system] : []), ...selected];
  return { messages: trimmed, dropped, truncated: dropped > 0 };
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
 * @returns {Promise<string>}
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
  return answer;
}
