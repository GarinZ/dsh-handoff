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
    throw finish.failure instanceof Error ? finish.failure : new Error(String(finish.failure ?? "side request failed"));
  }
  if (finish?.kind === "aborted") throw new Error("side request was aborted");

  const answer = text.trim();
  if (answer.length === 0) throw new Error("side request produced no text");
  return answer;
}
