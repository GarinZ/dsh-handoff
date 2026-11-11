/**
 * Append a handoff brief to a session that already has a model-visible surface.
 *
 * This is the fork path (`history: full`): the copied history supplied the
 * surface's protected head (the first `system/message`), so a plain user
 * message layered after the last `turn/end` is legal — it is simply the next
 * thing the model reads.
 *
 * It must NOT be used on a session with an empty surface. The release validator
 * rejects a `system/message` that is not the first surface node
 * (`dsh-session-format-v3-to-v4`, `foldSurface`: "system/message requires a
 * protected first surface head"), so a brief written as a bare surface node on
 * a brand-new summary-only session corrupts that session as soon as it is
 * prompted. Summary-only handoffs go through `openVisibleTurn` instead, which
 * keeps the brief in the inbox until the loop's own first step admits it.
 */

/**
 * @param session - live Session exposing `append`.
 * @param text - brief text recorded as one user-role surface message.
 * @param options - `messageId` reuses a caller-supplied id.
 * @returns `{ appended }`.
 */
export const appendBrief = (session, text, { messageId } = {}) => {
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
  return { appended: true };
};
