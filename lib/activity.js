/**
 * Per-session activity slot: what the side request is doing *right now*.
 *
 * Why this exists: a slash command settles before its side request finishes, so
 * the transcript card can only report the answer after the fact. While a turn
 * is running the transcript is also the worst place to look — it streams and
 * scrolls. The market BTW plugins solved the same problem with a fixed overlay
 * fed by a host route (`dsh-command-btw` polls `GET /btw/answer`), and this is
 * the same idea: one slot per session, streamed into, polled by the Client
 * overlay that ships in `client.js`.
 *
 * The slot is deliberately tiny and in-memory. It is a progress channel, not a
 * log: the durable record stays the `command/done` event, and a restart simply
 * loses the panel.
 */

/** @typedef {{id: string, kind: string, title: string, phase: string, question: string, target: string, status: "running"|"done"|"error", text: string, startedAt: number, endedAt: number, updatedAt: number}} Activity */

/**
 * @param {object} [options]
 * @param {() => number} [options.now] - injected clock, so tests can stay deterministic.
 */
export function createActivityStore({ now = () => Date.now() } = {}) {
  /** @type {Map<string, Activity>} */
  const activities = new Map();
  /** @type {Map<string, AbortController>} */
  const controllers = new Map();

  const snapshot = (entry) => (entry === undefined ? undefined : { ...entry });

  const begin = (sessionId, fields = {}) => {
    const entry = {
      id: `${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      kind: fields.kind ?? "side",
      title: fields.title ?? "侧路请求",
      phase: fields.phase ?? "",
      question: fields.question ?? "",
      target: fields.target ?? "",
      status: "running",
      text: "",
      startedAt: now(),
      endedAt: 0,
      updatedAt: now()
    };
    activities.set(String(sessionId), entry);
    return snapshot(entry);
  };

  const update = (sessionId, id, patch = {}) => {
    const entry = activities.get(String(sessionId));
    // A stale callback from a previous run must not overwrite the live slot.
    if (entry === undefined || (id !== undefined && entry.id !== id)) return snapshot(entry);
    Object.assign(entry, patch, { updatedAt: now() });
    return snapshot(entry);
  };

  const finish = (sessionId, id, status, patch = {}) => {
    controllers.delete(String(sessionId));
    return update(sessionId, id, { ...patch, status, endedAt: now() });
  };

  const get = (sessionId) => snapshot(activities.get(String(sessionId)));

  const track = (sessionId, controller) => {
    controllers.set(String(sessionId), controller);
  };

  /** Abort the live side request for one session; false when nothing runs. */
  const cancel = (sessionId) => {
    const key = String(sessionId);
    const controller = controllers.get(key);
    if (controller === undefined) return false;
    controllers.delete(key);
    controller.abort();
    return true;
  };

  const dispose = () => {
    for (const controller of controllers.values()) controller.abort();
    controllers.clear();
    activities.clear();
  };

  return { begin, update, finish, get, cancel, track, dispose };
}

/**
 * `GET /handoff/activity?session=<id>` — the Client overlay's polling target.
 * `?cancel=1` aborts the live call and reports whether anything was running.
 */
export function createActivityRoute(store) {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const sessionId = url.searchParams.get("session") ?? "";
    if (url.searchParams.get("cancel") === "1") {
      const cancelled = store.cancel(sessionId);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ cancelled }));
      return;
    }
    const activity = sessionId === "" ? undefined : store.get(sessionId);
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(activity ?? { status: "idle" }));
  };
}
