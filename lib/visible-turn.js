/**
 * Make a fresh session listable without corrupting its log.
 *
 * The GUI treats a Session as a real conversation only after a `turn/start`
 * (`dsh-api-session-controller`, `applySessionListMetadata`:
 * `blank: state.blank && event.type !== "turn/start"`), so a summary-only
 * handoff — a session with no turns at all — stays a hidden "new conversation"
 * placeholder even though its log already holds the brief.
 *
 * Writing that turn by hand does not work. The agent loop caches the last turn
 * number when it is constructed (`dsh-agent-loop`: `this.phase = { kind: "idle",
 * lastTurn }`), and a turn the plugin appends afterwards is invisible to that
 * cache: the user's first message then opens turn 1 *again*, and the reader
 * rejects the log ("turn/start does not open the expected turn"). A brief
 * written as a surface message before the loop's first `system/message` is
 * rejected too ("system/message requires a protected first surface head").
 *
 * So the loop itself opens this turn, with no step and no model call:
 *
 *   1. queue the brief as a normal prompt (`controller.prompt`),
 *   2. intercept the resulting `agent/pre-step` and put every claimed message
 *      back on the `next-step` inbox, so the user's first message picks it up,
 *   3. return `{ kind: "enter", messages: [] }` — the loop's own rule
 *      (`phase.step === 0 && decision.messages.length === 0`) closes the turn as
 *      `completed` without opening a step.
 *
 * The log therefore gains a closed, empty turn — enough for the sidebar — while
 * the brief stays pending in the inbox and becomes the first message of the
 * user's first real turn, admitted by the loop after its `system/message`.
 */

/** Default bound on one empty turn; it performs no model call. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Drive the loop's first turn to an immediate close and keep the brief queued.
 * @param ctx - plugin context exposing `on`.
 * @param controller - session controller exposing `prompt`.
 * @param sessionId - the fresh session to make visible.
 * @param text - brief text, queued as the user's first message of the next turn.
 * @param signal - caller cancellation for prompt admission.
 * @param timeoutMs - bound on waiting for the empty turn to close.
 * @returns `{ opened, requeued, reason? }`; `opened` is false when the hook never ran.
 */
export const openVisibleTurn = async ({
  ctx,
  controller,
  sessionId,
  text,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS
}) => {
  let close;
  const closed = new Promise((resolve) => {
    close = resolve;
  });
  let pending = true;
  let watchedTurn = 1;
  let requeued = 0;
  let offPreStep;
  let offEvent;

  if (typeof ctx?.on === "function") {
    offPreStep = ctx.on("agent/pre-step", async ({ agent, messages, turn, step }, next) => {
      if (!pending || agent?.id !== sessionId || step !== 1) return next();
      watchedTurn = turn;
      pending = false;
      // Hand the claimed brief back for the user's first real turn instead of
      // letting it reach the surface ahead of the loop's system message. It
      // goes on `next-step`, which every later `claim` drains together with the
      // user's queued turn: the brief and that first message are read by the
      // model in one request, never as a turn of their own.
      for (const message of messages) {
        try {
          agent.inbox.append("next-step", message);
          requeued += 1;
        } catch {
          // A message that cannot be queued again is dropped: keeping the
          // surface empty matters more than keeping the brief.
        }
      }
      return { kind: "enter", messages: [] };
    });
    offEvent = ctx.on("session/event", (session, event) => {
      if (session?.id !== sessionId || event?.type !== "turn/end" || event.data?.turn !== watchedTurn) return;
      close();
    });
  }

  let opened = false;
  let admitted = false;
  try {
    await controller.prompt(
      { requestId: globalThis.crypto.randomUUID(), sessionId, mode: "queue", content: [{ type: "text", text }] },
      signal
    );
    admitted = true;
    opened = await Promise.race([
      closed.then(() => true),
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    offEvent?.();
    // The hook only matters while the brief can still be claimed. Once the turn
    // ends (or never starts) it can no longer fire, and keeping it would hijack
    // an unrelated later turn.
    if (!pending || !admitted || opened) offPreStep?.();
  }
  const reason = opened ? (pending ? "brief-surfaced" : undefined) : "turn-not-closed";
  return { opened, requeued, ...(reason === undefined ? {} : { reason }) };
};
