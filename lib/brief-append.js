/**
 * Append a handoff brief to a session that was never prompted.
 *
 * Two things must both be true for the GUI to treat the new session as real:
 * the brief has to be on the model-visible surface, and the session's
 * `sessionListMetadata.blank` projection has to be cleared. Only a `turn/start`
 * clears it (`dsh-api-session-controller`, `applySessionListMetadata`:
 * `blank: state.blank && event.type !== "turn/start"`), which is why a
 * summary-only handoff — a fresh session with no turns at all — used to stay a
 * hidden "new conversation" placeholder even though its log already held the
 * brief.
 *
 * The wrapping turn carries no step and no assistant message: the agent loop
 * itself closes turns without a step when the input was empty or rejected, so
 * nothing is sent to a model and no tool runs.
 */

/**
 * @param session - live Session exposing `append` and `snapshotEvents`.
 * @param text - brief text recorded as one user-role surface message.
 * @param options - `ensureVisible` wraps the brief in a closed turn when the log
 *   has no `turn/start` yet; `messageId` reuses a caller-supplied id.
 * @returns `{ appended, openedTurn }`.
 */
export const appendBrief = (session, text, { ensureVisible = false, messageId } = {}) => {
  const openedTurn =
    ensureVisible === true && !session.snapshotEvents().some((event) => event.type === "turn/start");
  if (openedTurn) session.append("turn/start", { turn: 1 });
  session.append(
    "user/message",
    {
      id: messageId ?? globalThis.crypto.randomUUID(),
      role: "user",
      content: [{ type: "text", text }],
      source: { kind: "user" }
    },
    { surfaceOp: "append" }
  );
  if (openedTurn) session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
  return { appended: true, openedTurn };
};
