/**
 * dsh-handoff — model-facing session handoff for DeepSeek Harness.
 *
 * One tool, two history policies:
 *
 *   **full** (default) — `ctx.sessionController.fork()` copies this session's
 *   exact event prefix into a brand-new, independent session (no
 *   `parentSession`, so the sidebar and the resumable set keep showing it),
 *   then relocates it into the target workspace: the stored log's header is
 *   rewritten, the live write handle is re-pinned, and the workspace ledger is
 *   swapped. Nothing restarts.
 *
 *   **summary** — nothing is copied. `ctx.sessionController.create()` opens a
 *   blank session directly in the target workspace and only the handoff brief
 *   is written into it. This is the escape hatch when the source history is
 *   too large to carry (for example when a plugin with no proactive compaction
 *   keeps the context saturated): a fork would inherit that pressure and be
 *   unusable, while a summary-only session starts clean.
 *
 * In both modes the brief is appended as the new session's first message, and
 * the source session is never modified.
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
        "With history=summary this brief is the ONLY thing the new session receives, so it must stand on its own — say which files to reopen and what to re-check. With history=full it supplements the copied transcript, so keep it compact (a few hundred words) and do not repeat what is obvious from the transcript."
    },
    history: {
      type: "string",
      enum: ["full", "summary"],
      description:
        "How much of this conversation the new session carries. " +
        "full (default) copies the complete event history — use it whenever the target session needs exact context and the source is still healthy. " +
        "summary copies NOTHING and starts the target from the brief alone — use it when the source history is already enormous or the context is nearly exhausted (a plugin without proactive compaction, repeated compaction failures, or a user who explicitly asks for 只写总结 / summary only). " +
        "A fork inherits the source's context pressure, so handing a saturated session off with full history can leave the new session unable to continue; when in doubt on a very long conversation, prefer summary."
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
    history: { type: "string", enum: ["full", "summary"] },
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

  const buildSummaryOnlyBrief = (sourceId, sourceCwd, summary) =>
    `【Handoff 交接简报（仅摘要） / handoff brief — summary only】\n` +
    `From session ${sourceId} (workspace ${sourceCwd}).\n` +
    `The full history was NOT copied: this session starts from this brief alone. Files are still on disk at the paths below — reopen what this brief names before changing anything.\n\n` +
    summary;

  /**
   * summary-only handoff: a blank session in the target workspace, plus the brief.
   *
   * Nothing is forked, so the new session starts with an empty context instead
   * of inheriting a saturated one, and `create()` writes it straight into the
   * target workspace — no relocation, no working-directory fix-up.
   */
  const handoffSummaryOnly = async ({ controller, workspace, workspaceCreated, source, sourceId, summary, args, exec }) => {
    const created = await controller.create({ workspaceId: workspace.id });
    const childId = created?.sessionId;
    if (typeof childId !== "string" || childId.length === 0) {
      throw new Error("handoff: the session controller did not return a new session id");
    }

    let appliedTitle;
    const requestedTitle = typeof args?.title === "string" ? args.title.trim() : "";
    if (requestedTitle.length > 0) {
      try {
        const renamed = await controller.rename({ sessionId: childId, title: requestedTitle });
        appliedTitle = typeof renamed?.title === "string" ? renamed.title : requestedTitle;
      } catch (error) {
        log.warn?.(`dsh-handoff: renaming ${childId} failed, keeping the generated title: ${String(error)}`);
      }
    }

    const child = ctx.sessions.get(childId);
    const { briefAttached, turnStarted } = await attachBrief({
      controller,
      sessionId: childId,
      session: child,
      text: buildSummaryOnlyBrief(sourceId, source.header.cwd, summary),
      startTurn: args?.start_turn === true,
      signal: exec.signal ?? new AbortController().signal
    });

    log.info?.(`dsh-handoff: ${sourceId} handed off (summary only) to ${childId} in ${workspace.path}`);
    return {
      sessionId: childId,
      workspacePath: workspace.path,
      workspaceTitle: String(workspace.title ?? basename(workspace.path)),
      workspaceCreated,
      history: "summary",
      ...(appliedTitle === undefined ? {} : { title: appliedTitle }),
      briefAttached,
      turnStarted,
      cwdSynced: "synced",
      note:
        `已在工作区「${workspace.title}」(${workspace.path}) 新建会话 ${childId}，它只带着交接简报、没有复制历史。` +
        `原会话保持不变；如果新会话需要精确上下文，可以改用 history=full 重新交接。`
    };
  };

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
      "Hand off this conversation to another workspace. By default it copies this session's COMPLETE history into a brand-new session located in the target directory, then records the handoff brief you write as that session's first message — so work continues there with full context plus a summary, while this session stays exactly as it is. " +
      "With history=summary nothing is copied: the new session starts from your brief alone, which is the right choice when this conversation is already too large to carry (a fork inherits the source's context pressure, so a saturated session handed off with full history can leave the new session unable to continue). " +
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
      const history = args?.history === "summary" ? "summary" : "full";
      if (history === "summary" && args?.mode === "move") {
        throw new Error(
          "handoff: history=summary cannot be combined with mode=move — move relocates this session itself (with its full history) at the end of the turn. " +
          "Use mode=copy (the default) for a summary-only handoff, or drop history=summary to move this session."
        );
      }

      const agent = exec.agent;
      const sourceId = agent?.session?.id ?? exec.sessionId;
      if (sourceId === undefined) throw new Error("handoff: no calling session");
      const source = ctx.sessions.get(sourceId) ?? agent?.session;
      if (source === undefined) throw new Error(`handoff: session ${sourceId} is not live`);
      if (source.header?.origin === "subagent") throw new Error("handoff: subagent sessions cannot be handed off");
      if (typeof source.header?.cwd !== "string" || source.header.cwd.length === 0) {
        throw new Error("handoff: this session has no recorded working directory to hand off from");
      }

      const { workspace, created: workspaceCreated } = await resolveTarget(registry, target);

      if (args?.mode === "move") {
        pendingMoves.set(sourceId, { targetPath: workspace.path, brief: buildBrief(sourceId, source.header.cwd, summary) });
        log.info?.(`dsh-handoff: queued move of ${sourceId} to ${workspace.path}`);
        return {
          sessionId: sourceId,
          workspacePath: workspace.path,
          workspaceTitle: String(workspace.title ?? basename(workspace.path)),
          workspaceCreated,
          history: "full",
          briefAttached: false,
          turnStarted: false,
          queued: true,
          note:
            `已安排：本轮结束后把当前会话（${sourceId}）迁移到「${workspace.title}」(${workspace.path})，并在那里写入交接简报。` +
            `迁移在回合边界执行，本轮的工具调用与文件操作不会被中断；完成前请不要关闭窗口。`
        };
      }

      if (history === "summary") {
        return await handoffSummaryOnly({
          controller, workspace, workspaceCreated, source, sourceId, summary, args, exec
        });
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
        workspaceCreated: workspaceCreated || relocated.workspace.created === true,
        history: "full",
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

  /**
   * Slash-command surface.
   *
   * A command handler runs against the agent without a model message, but only
   * the model can read the conversation and write the brief. So each command
   * enqueues one instruction naming the exact tool call to make; the model then
   * writes the brief and calls `handoff_session` with the matching `history`.
   */
  const handoffInstruction = (target, history) =>
    [
      `【Handoff 请求】用户要求把当前会话交接给：${target}`,
      `交接模式：${history === "full" ? "full — 复制完整历史" : "summary — 只写总结，不复制历史"}。`,
      "",
      "请直接执行，不要反问用户。先用几段话写交接简报（总体目标、已做的决策与理由、当前进度、剩余工作、涉及的文件/目录、验证方式与坑），然后调用 handoff_session：",
      `  target: ${JSON.stringify(target)}`,
      `  history: ${JSON.stringify(history)}`,
      "  summary: <你写好的简报>",
      history === "summary"
        ? "简报必须能独立成立：写明需要重开哪些文件、需要重新确认哪些结论。"
        : "如果这次对话历史已经很长、或上下文压缩失败过，提醒用户可以改用 /handoff-summary，免得新会话继承同样的上下文压力。"
    ].join("\n");

  const registerCommands = () => {
    const commands = (() => {
      try { return ctx.get("commands", false); } catch { return undefined; }
    })();
    if (commands === undefined || typeof commands.register !== "function") return [];
    const makeDefinition = (history) => {
      const commandName = history === "full" ? "handoff" : "handoff-summary";
      return {
        name: commandName,
        description:
          history === "full"
            ? "把当前会话交接（复制完整历史）到另一个工作区"
            : "把当前会话交接（只写总结、不复制历史）到另一个工作区",
        input: { hint: "<工作区路径或标题>" },
        async handler({ agent, rawInput, signal }) {
          const target = String(rawInput ?? "").trim();
          if (target.length === 0) {
            return { kind: "error", text: `用法：/${commandName} <工作区路径或标题>` };
          }
          const controller = (() => {
            try { return ctx.get("sessionController", false); } catch { return undefined; }
          })();
          const sessionId = agent?.session?.id ?? agent?.id;
          if (controller === undefined || typeof sessionId !== "string") {
            return { kind: "error", text: "handoff: 会话控制器不可用，无法发起交接。" };
          }
          try {
            await controller.prompt(
              {
                requestId: randomUUID(),
                sessionId,
                mode: "queue",
                content: [{ type: "text", text: handoffInstruction(target, history) }]
              },
              signal
            );
          } catch (error) {
            return {
              kind: "error",
              text: `handoff: 无法把交接请求交给 Agent：${error instanceof Error ? error.message : String(error)}`
            };
          }
          return {
            kind: "success",
            text: `已提交交接请求（${history === "full" ? "复制完整历史" : "仅摘要"}）→ ${target}；Agent 写完简报后会创建新会话。`
          };
        }
      };
    };
    return [commands.register(makeDefinition("full")), commands.register(makeDefinition("summary"))];
  };

  const disposers = [
    ctx.tools.register(handoffTool),
    ...registerCommands(),
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
