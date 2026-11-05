/**
 * dsh-handoff — model-facing session handoff for DeepSeek Harness.
 *
 * One tool, three steps:
 *
 *   1. **fork**  — `ctx.sessionController.fork()` copies this session's exact
 *      event prefix into a brand-new, independent session (no `parentSession`,
 *      so the sidebar and the resumable set keep showing it).
 *   2. **move**  — the fork is relocated into the target workspace: the stored
 *      log's header is rewritten, the live write handle is re-pinned, and the
 *      workspace ledger is swapped. Nothing restarts; the new session appears in
 *      the target workspace while the source keeps running untouched.
 *   3. **brief** — the handoff summary the model wrote is appended to the new
 *      session as its first message, so the next reader starts with both the
 *      full history and a compact brief.
 *
 * The source session is never modified: this is a copy, not a move.
 */
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { realpath, stat } from "node:fs/promises";
import { relocateSession } from "./lib/relocate.js";

export const name = "dsh-handoff";
export const inject = ["tools", "agents", "sessions"];

const PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["target", "summary"],
  properties: {
    target: {
      type: "string",
      description:
        "Where the new session should live: a workspace path (absolute, or starting with ~), a workspace id, or an exact workspace title. " +
        "A directory that has no workspace record yet gets one created. Relative paths are rejected — ask the user for the full path instead of guessing."
    },
    summary: {
      type: "string",
      description:
        "The handoff brief recorded as the new session's first message. Write it in the user's language and cover: the overall goal, decisions already made, what is done, what remains, files/directories touched, and any gotchas or verification the next session must know. " +
        "It supplements the copied history, so keep it compact (a few hundred words) and do not repeat what is obvious from the transcript."
    },
    mode: {
      type: "string",
      enum: ["copy", "move"],
      description:
        "copy (default) leaves this session untouched and starts a new one in the target workspace. move relocates THIS session into the target workspace at the end of the current turn — same id, history kept — and records the brief before it goes; use it only when the user wants this conversation itself to continue elsewhere."
    },
    title: {
      type: "string",
      description:
        "Optional title for the new session so the copy is distinguishable in the sidebar. Omit to keep the source title."
    },
    start_turn: {
      type: "boolean",
      description:
        "Run one turn in the new session immediately (it receives the brief as a prompt and answers it). Defaults to false, which only records the brief. Set it when the user wants the handoff to continue working right away."
    }
  }
};

const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sessionId", "workspacePath", "workspaceTitle", "workspaceCreated", "briefAttached", "turnStarted"],
  properties: {
    sessionId: { type: "string" },
    workspacePath: { type: "string" },
    workspaceTitle: { type: "string" },
    workspaceCreated: { type: "boolean" },
    title: { type: "string" },
    copiedEvents: { type: "number" },
    briefAttached: { type: "boolean" },
    queued: { type: "boolean" },
    turnStarted: { type: "boolean" },
    cwdSynced: { type: "string", enum: ["synced", "recorded", "unavailable"] },
    note: { type: "string" }
  }
};

function renderValue(_args, value) {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

function expandHomePath(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return value;
}

async function resolveDirectory(path) {
  let real;
  try {
    real = await realpath(path);
  } catch {
    return undefined;
  }
  try {
    if (!(await stat(real)).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  return real;
}

function workspaceListText(workspaces) {
  if (workspaces.length === 0) return "(none registered)";
  return workspaces.map((workspace) => `- ${workspace.title} — ${workspace.path}`).join("\n");
}

export function apply(ctx) {
  const log = ctx.logger ?? console;

  /** Resolve the Handoff to the workspace the user named: id, exact title, or directory. */
  const resolveTarget = async (registry, raw) => {
    const workspaces = registry.list();
    const byId = workspaces.find((workspace) => workspace.id === raw);
    if (byId !== undefined) return { workspace: byId, created: false };
    const byTitle = workspaces.find((workspace) => String(workspace.title ?? "").toLowerCase() === raw.toLowerCase());
    if (byTitle !== undefined) return { workspace: byTitle, created: false };

    const directory = await resolveDirectory(expandHomePath(raw));
    if (directory === undefined) {
      throw new Error(
        `handoff: "${raw}" is neither a registered workspace nor an existing directory.\n` +
        `Pass an absolute path that exists, or one of these workspaces:\n${workspaceListText(workspaces)}`
      );
    }
    const existing = await registry.resolveByPath(directory).catch(() => undefined);
    if (existing !== undefined) return { workspace: existing, created: false };
    return { workspace: await registry.create(directory, basename(directory)), created: true };
  };

  /** Record the brief in the new session: a plain message, or a real turn when asked. */
  const attachBrief = async ({ controller, sessionId, session, text, startTurn, signal }) => {
    if (startTurn) {
      await controller.prompt(
        { requestId: randomUUID(), sessionId, mode: "queue", content: [{ type: "text", text }] },
        signal
      );
      return { briefAttached: true, turnStarted: true };
    }
    if (session !== undefined && typeof session.append === "function") {
      try {
        session.append(
          "user/message",
          { id: randomUUID(), role: "user", content: [{ type: "text", text }], source: { kind: "user" } },
          { surfaceOp: "append" }
        );
        return { briefAttached: true, turnStarted: false };
      } catch (error) {
        log.warn?.(`dsh-handoff: direct brief append failed, falling back to a prompt: ${String(error)}`);
      }
    }
    await controller.prompt(
      { requestId: randomUUID(), sessionId, mode: "queue", content: [{ type: "text", text }] },
      signal
    );
    return { briefAttached: true, turnStarted: true };
  };

  const buildBrief = (sourceId, sourceCwd, summary) =>
    `【Handoff 交接简报 / handoff brief】\n` +
    `From session ${sourceId} (workspace ${sourceCwd}).\n` +
    `Full history above was copied verbatim; this brief is the summary written at handoff time.\n\n` +
    summary;

  /** Queue a relocation of the calling session; it runs when the current turn ends. */
  const pendingMoves = new Map();
  const settleMove = async (session) => {
    const pending = pendingMoves.get(session.id);
    if (pending === undefined) return;
    pendingMoves.delete(session.id);
    const registry = ctx.get("workspaceRegistry", false);
    const persistence = ctx.get("sessionPersistence", false);
    const controller = ctx.get("sessionController", false);
    if (registry === undefined || persistence === undefined) {
      log.warn?.("dsh-handoff: queued move dropped — workspace registry or session persistence is unavailable");
      return;
    }
    try {
      const relocated = await relocateSession(
        { persistence, registry },
        { id: session.id, header: session.header, session },
        pending.targetPath
      );
      log.info?.(`dsh-handoff: moved ${session.id} to ${relocated.workspace.path} at turn end`);
      if (controller !== undefined && typeof session.append === "function") {
        try {
          session.append(
            "user/message",
            { id: randomUUID(), role: "user", content: [{ type: "text", text: pending.brief }], source: { kind: "user" } },
            { surfaceOp: "append" }
          );
        } catch (error) {
          log.warn?.(`dsh-handoff: brief append after the move failed: ${String(error)}`);
        }
      }
    } catch (error) {
      log.warn?.(`dsh-handoff: queued move of ${session.id} to ${pending.targetPath} failed: ${String(error)}`);
    }
  };

  const handoffTool = {
    name: "handoff_session",
    description:
      "Hand off this conversation to another workspace. It copies this session's COMPLETE history into a brand-new session located in the target directory, then records the handoff brief you write as that session's first message — so work continues there with full context plus a summary, while this session stays exactly as it is. " +
      "Use it whenever the user wants to continue this work somewhere else: 交接 / 转交 / 迁移 / 搬到 / 复制到 / 换个工作区继续 / move & continue in another repo / hand this off to another project / start a new session there with everything. " +
      "Prefer it over manually copying files, re-explaining the context, or telling the user to start a blank session: those lose the history this tool carries. " +
      "The new session is created live — no restart needed; the user just opens it from the target workspace in the sidebar.",
    parameters: PARAMETERS,
    output: { schema: RESULT_SCHEMA, render: renderValue },
    presentCall(args) {
      const target = typeof args?.target === "string" ? args.target : "";
      return { card: "generic", title: `handoff → ${target}`.trim(), kind: "other", rawInput: JSON.stringify(args) ?? "" };
    },
    async execute(args, exec) {
      const controller = ctx.get("sessionController", false);
      const registry = ctx.get("workspaceRegistry", false);
      const persistence = ctx.get("sessionPersistence", false);
      if (controller === undefined || registry === undefined || persistence === undefined) {
        throw new Error("handoff: this dsh build does not expose the session controller, workspace registry, and session persistence services together");
      }
      const target = typeof args?.target === "string" ? args.target.trim() : "";
      const summary = typeof args?.summary === "string" ? args.summary.trim() : "";
      if (target.length === 0) throw new Error("handoff: `target` must be a non-empty workspace path, id, or title");
      if (summary.length === 0) throw new Error("handoff: `summary` must be a non-empty handoff brief");

      const agent = exec.agent;
      const sourceId = agent?.session?.id ?? exec.sessionId;
      if (sourceId === undefined) throw new Error("handoff: no calling session");
      const source = ctx.sessions.get(sourceId) ?? agent?.session;
      if (source === undefined) throw new Error(`handoff: session ${sourceId} is not live`);
      if (source.header?.origin === "subagent") throw new Error("handoff: subagent sessions cannot be handed off");
      if (typeof source.header?.cwd !== "string" || source.header.cwd.length === 0) {
        throw new Error("handoff: this session has no recorded working directory to hand off from");
      }

      const { workspace, created } = await resolveTarget(registry, target);

      if (args?.mode === "move") {
        pendingMoves.set(sourceId, { targetPath: workspace.path, brief: buildBrief(sourceId, source.header.cwd, summary) });
        log.info?.(`dsh-handoff: queued move of ${sourceId} to ${workspace.path}`);
        return {
          sessionId: sourceId,
          workspacePath: workspace.path,
          workspaceTitle: String(workspace.title ?? basename(workspace.path)),
          workspaceCreated: created,
          briefAttached: false,
          turnStarted: false,
          queued: true,
          note:
            `已安排：本轮结束后把当前会话（${sourceId}）迁移到「${workspace.title}」(${workspace.path})，并在那里写入交接简报。` +
            `迁移在回合边界执行，本轮的工具调用与文件操作不会被中断；完成前请不要关闭窗口。`
        };
      }

      // The fork reads the durable log; flush first so the last buffered events are included.
      try {
        await ctx.sessions.flush(source);
      } catch (error) {
        log.warn?.(`dsh-handoff: flushing the source session failed, forking the last durable prefix: ${String(error)}`);
      }

      const forked = await controller.fork({ sessionId: sourceId });
      const childId = forked?.sessionId;
      if (typeof childId !== "string" || childId.length === 0) {
        throw new Error("handoff: the session controller did not return a forked session id");
      }

      let child = ctx.sessions.get(childId);
      if (child !== undefined) {
        try {
          await ctx.sessions.flush(child);
        } catch { /* the staged log below re-reads whatever is durable */ }
      }

      let relocated;
      try {
        relocated = await relocateSession(
          { persistence, registry },
          { id: childId, header: child?.header ?? (await readStoredHeader(persistence, childId)), session: child },
          workspace.path
        );
      } catch (error) {
        log.warn?.(`dsh-handoff: fork ${childId} was created but could not be relocated: ${String(error)}`);
        throw new Error(
          `handoff: the new session ${childId} was created in the source workspace but moving it to "${workspace.path}" failed: ${error instanceof Error ? error.message : String(error)}. ` +
          "It is still available in the original workspace."
        );
      }

      // The fork starts life in the SOURCE directory, so its working-directory
      // projection is already committed to that path. Relocating the log does not
      // re-initialise the projection (the cached row keeps winning over the new
      // header), which would leave every tool call running in the old project.
      // Route the change through the host service — the same path a user `cd` uses.
      const cwdSynced = await syncWorkingDirectory(ctx, log, childId, relocated.workspace.path);

      let appliedTitle;
      if (typeof args?.title === "string" && args.title.trim().length > 0) {
        try {
          const renamed = await controller.rename({ sessionId: childId, title: args.title.trim() });
          appliedTitle = typeof renamed?.title === "string" ? renamed.title : args.title.trim();
        } catch (error) {
          log.warn?.(`dsh-handoff: renaming ${childId} failed, keeping the inherited title: ${String(error)}`);
        }
      }

      child = ctx.sessions.get(childId) ?? child;
      const brief =
        `【Handoff 交接简报 / handoff brief】\n` +
        `From session ${sourceId} (workspace ${source.header.cwd}).\n` +
        `Full history above was copied verbatim; this brief is the summary written at handoff time.\n\n` +
        summary;
      const { briefAttached, turnStarted } = await attachBrief({
        controller,
        sessionId: childId,
        session: child,
        text: brief,
        startTurn: args?.start_turn === true,
        signal: exec.signal ?? new AbortController().signal
      });

      const copiedEvents = typeof child?.seq === "number" ? child.seq + 1 : undefined;
      log.info?.(`dsh-handoff: ${sourceId} handed off to ${childId} in ${relocated.workspace.path}`);

      return {
        sessionId: childId,
        workspacePath: relocated.workspace.path,
        workspaceTitle: String(relocated.workspace.title ?? basename(relocated.workspace.path)),
        workspaceCreated: created || relocated.workspace.created === true,
        ...(copiedEvents === undefined ? {} : { copiedEvents }),
        ...(appliedTitle === undefined ? {} : { title: appliedTitle }),
        briefAttached,
        turnStarted,
        cwdSynced,
        note:
          `已把当前会话的完整历史复制到新会话 ${childId}，它现在位于工作区「${relocated.workspace.title}」(${relocated.workspace.path})` +
          `，并附上了交接简报。原会话保持不变；用户在目标工作区的侧栏里打开新会话即可继续。`
      };
    }
  };

  const disposers = [
    ctx.tools.register(handoffTool),
    ctx.on("session/event", (session, event) => {
      if (event?.type === "turn/end") void settleMove(session);
    })
  ];
  return () => {
    for (const disposer of disposers) {
      try {
        disposer();
      } catch { /* unloading is best-effort */ }
    }
  };
}

/**
 * Commit the child session's new directory into its working-directory
 * projection.
 *
 * A fork is a live Agent whose projection was seeded from the source header, so
 * rewriting the log header alone leaves `workingDirectory` pointing at the old
 * project — every tool call would then run there. Prefer the `workingDirectory`
 * service (the same path a user `cd` takes: it commits durably and emits the
 * model-visible change); fall back to appending the equivalent event.
 *
 * @returns {"synced"|"recorded"|"unavailable"} how the change was committed.
 */
async function syncWorkingDirectory(ctx, log, sessionId, targetPath) {
  const service = (() => {
    try { return ctx.get("workingDirectory"); } catch { return undefined; }
  })();
  const agent = (() => {
    try { return ctx.agents?.get?.(sessionId); } catch { return undefined; }
  })();
  if (service !== undefined && typeof service.set === "function" && agent !== undefined) {
    try {
      await service.set(agent, targetPath);
      return "synced";
    } catch (error) {
      log.warn?.(`dsh-handoff: workingDirectory.set failed for ${sessionId}, recording the change event instead: ${String(error)}`);
    }
  }
  const session = ctx.sessions.get(sessionId);
  if (session !== undefined && typeof session.append === "function") {
    try {
      session.append("working-directory/change", { cwd: targetPath });
      return "recorded";
    } catch (error) {
      log.warn?.(`dsh-handoff: could not record the working-directory change for ${sessionId}: ${String(error)}`);
    }
  }
  return "unavailable";
}

/** Read one session header straight from persistence when the fork is not live. */
async function readStoredHeader(persistence, sessionId) {
  const list = typeof persistence?.list === "function" ? await persistence.list() : [];
  const header = list.find((row) => row?.id === sessionId);
  if (header === undefined) throw new Error(`handoff: no stored header for session ${sessionId}`);
  return header;
}
