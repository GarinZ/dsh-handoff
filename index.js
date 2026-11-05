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
import { BTW_SYSTEM_PROMPT, buildBriefPrompt, buildInstructionText, buildSideThread } from "./lib/prompts.js";
import {
  askSideModel,
  buildTranscript,
  countConversationMessages,
  formatFailure,
  resolveRoute,
  snapshotMessages
} from "./lib/side-request.js";
import { createActivityRoute, createActivityStore, readJsonBody } from "./lib/activity.js";

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
        "The handoff brief recorded as the new session's first message. Write it in the user's language, in the imperative, using exactly this skeleton (keep every heading, write 无 when a section is empty): " +
        "## 目标 / ## 决策 (each decision plus its reason) / ## 已完成 (paths, commands, test results) / ## 剩余 / ## 关键上下文 (exact paths, symbols, error strings, config values) / ## 下一步 (the first action in the new session). " +
        "Rules: use only facts that appear in this conversation — never invent paths, line numbers, commands, or conclusions; if a critical detail is unknown, say so in one line and give the smallest step to verify it; never list this handoff itself as progress or as a next step; put the brief only in this argument, do not repeat it in your chat reply. " +
        "With history=summary this brief is the ONLY thing the new session receives, so it must stand on its own — which files to reopen and which conclusions to re-check. With history=full it supplements the copied transcript, so keep it compact and do not repeat what the transcript shows."
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
  /**
   * Progress channel for the Client overlay: what each session's side request
   * is doing right now. The command card is the archive; this is the live view,
   * so it stays visible while the conversation streams.
   */
  const activity = createActivityStore();
  // Side answers live outside the session history, so keep the last few pairs
  // in memory: a follow-up ("那第二步呢？") otherwise starts from nothing.
  const btwThreads = new Map();
  const BTW_THREAD_LIMIT = 12;
  const rememberBtw = (sessionId, question, answer) => {
    const thread = btwThreads.get(sessionId) ?? [];
    thread.push({ question, answer });
    while (thread.length > BTW_THREAD_LIMIT) thread.shift();
    btwThreads.set(sessionId, thread);
  };

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

  /**
   * Best-effort target picked straight out of a command's natural-language
   * request: an existing directory path, exactly one workspace title mentioned
   * in the text, or exactly one workspace id. Anything ambiguous returns
   * `undefined` so the caller falls back to the model, which can ask.
   */
  const guessTarget = async (registry, request) => {
    if (request.length === 0) return undefined;
    const pathMatch = request.match(/(?:^|[\s"'“”「」『』(（])((?:~\/|\/)[^\s"'“”「」『』()（）,，。；;]+)/);
    if (pathMatch !== null) {
      const candidate = pathMatch[1].replace(/[.,;:!?。，；：！？]+$/u, "");
      if ((await resolveDirectory(expandHomePath(candidate))) !== undefined) return candidate;
    }
    const workspaces = registry.list();
    const folded = request.toLowerCase();
    const byTitle = workspaces.filter((workspace) => {
      const title = String(workspace.title ?? "").trim().toLowerCase();
      return title.length > 0 && folded.includes(title);
    });
    if (byTitle.length === 1) return byTitle[0].id;
    const byId = workspaces.filter((workspace) => request.includes(workspace.id));
    if (byId.length === 1) return byId[0].id;
    return undefined;
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
    `Full history above was copied verbatim; this brief is the summary written at handoff time.\n` +
    `Read it as your own working memory, not as a user request: “下一步” is the plan you inherited — re-check it against the latest user instruction before acting, and build on the work below instead of repeating it.\n\n` +
    summary;

  const buildSummaryOnlyBrief = (sourceId, sourceCwd, summary) =>
    `【Handoff 交接简报（仅摘要） / handoff brief — summary only】\n` +
    `From session ${sourceId} (workspace ${sourceCwd}).\n` +
    `The full history was NOT copied: this session starts from this brief alone. Files are still on disk at the paths below — reopen what this brief names before changing anything.\n` +
    `Read it as your own working memory, not as a user request: “下一步” is the plan you inherited — re-check it against the latest user instruction before acting.\n\n` +
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
      if (typeof source.deriveMessages === "function") {
        const messages = countConversationMessages(snapshotMessages(source));
        if (messages < 2) {
          throw new Error(
            "handoff: 这次会话还没有可交接的对话（至少需要一问一答）。先做点工作，或者等这一轮结束再交接。"
          );
        }
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
   * Preferred path: snapshot the live session, ask the model for the brief out
   * of band (`ctx.llm.stream` — no agent turn, nothing written into this
   * conversation), then hand that brief straight to `handoff_session`. Same
   * shape as the BTW plugins in the market.
   *
   * Fallback: when the side request cannot run (no llm service, no route in the
   * header, too little conversation, or a target the request does not name
   * unambiguously) enqueue one instruction naming the exact tool call, and the
   * model writes the brief itself in a real turn.
   */
  const getService = (key) => {
    try { return ctx.get(key, false); } catch { return undefined; }
  };

  /**
   * Late command results.
   *
   * A command handler runs inside the client's submit transaction: the composer
   * keeps the draft and stays busy until the handler settles. A side request
   * takes seconds (it uploads the whole conversation), so awaiting one inside a
   * handler freezes the input box for that long. Instead the handler returns a
   * placeholder at once, the composer clears, and the answer is delivered later
   * by appending a second `command/done` for the same command id — the client's
   * command node is keyed by that id, so the flow node updates in place.
   *
   * The append must follow the executor's own settlement event, otherwise that
   * event would overwrite the answer with the placeholder.
   */
  const lateResults = new Map();

  const flushLateResult = (key) => {
    const record = lateResults.get(key);
    if (record === undefined || !record.settled || record.outcome === undefined) return;
    lateResults.delete(key);
    clearTimeout(record.deadline);
    const session = record.session;
    if (session === undefined || typeof session.append !== "function") {
      log.warn?.(`dsh-handoff: late result for command ${record.commandId} lost its session`);
      return;
    }
    try {
      session.append("command/done", {
        commandId: record.commandId,
        kind: record.outcome.kind,
        text: record.outcome.text
      });
    } catch (error) {
      log.warn?.(`dsh-handoff: could not publish the late command result: ${String(error)}`);
    }
  };

  const scheduleLateResult = (invocation, placeholder, work, hooks = {}) => {
    const commandId = invocation?.commandId;
    const session = invocation?.agent?.session;
    if (commandId === undefined || session === undefined || typeof session.append !== "function") return false;
    const key = String(commandId);
    const controller = new AbortController();
    hooks.onController?.(controller);
    const record = { commandId, session, sessionId: session.id, settled: false, outcome: undefined, deadline: undefined, controller };
    lateResults.set(key, record);
    // Safety net: if the settlement event never reaches this listener, publish anyway.
    record.deadline = setTimeout(() => {
      record.settled = true;
      flushLateResult(key);
    }, 10_000);
    record.deadline.unref?.();
    work(controller.signal).then(
      (text) => {
        record.outcome = { kind: "success", text: String(text) };
        flushLateResult(key);
      },
      (error) => {
        controller.abort();
        const prefix = hooks.failurePrefix ?? `${placeholder}失败`;
        record.outcome = { kind: "error", text: `${prefix}：${formatFailure(error)}` };
        flushLateResult(key);
      }
    );
    return true;
  };

  /** Cheap checks only: everything here must stay fast enough to run before returning. */
  const planSideHandoff = async ({ agent, sessionId, request, history }) => {
    const registry = getService("workspaceRegistry");
    const llm = getService("llm");
    if (registry === undefined || llm === undefined || typeof llm.stream !== "function") return undefined;
    const session = agent?.session;
    if (session === undefined) return undefined;
    const route = resolveRoute(session);
    if (typeof route.provider !== "string" || typeof route.model !== "string") return undefined;
    const target = await guessTarget(registry, request);
    if (target === undefined) return undefined;
    const messages = snapshotMessages(session);
    if (countConversationMessages(messages) < 2) return undefined;
    // A handoff brief is worth a bigger window than a side question, but never
    // the whole session: providers reject structured replays and the bill is
    // not worth it. Flatten to text, newest messages first in the budget.
    const transcript = buildTranscript(messages, { maxChars: 400_000 });
    if (transcript.text.length === 0) return undefined;
    return { llm, session, route, target, transcript };
  };

  const executeSideHandoff = async (plan, { agent, sessionId, request, history, signal, onBriefDelta, onPhase }) => {
    const answered = await askSideModel(plan.llm, {
      provider: plan.route.provider,
      model: plan.route.model,
      system: buildBriefPrompt({
        request,
        history,
        truncated: plan.transcript.truncated,
        dropped: plan.transcript.dropped
      }),
      messages: [{
        role: "user",
        content: [{ type: "text", text: `<conversation>\n${plan.transcript.text}\n</conversation>` }]
      }],
      sessionId,
      signal,
      onDelta: onBriefDelta
    });
    const brief = answered.finishKind === "max-tokens"
      ? `${answered.text}\n\n> 简报达到输出长度上限（max-tokens），末尾被截断。`
      : answered.text;
    onPhase?.("正在创建会话…");
    const result = await handoffTool.execute({ target: plan.target, summary: brief, history }, { agent, sessionId, signal });
    return { result, brief };
  };

  /**
   * A side question only needs the recent stretch of the conversation, and it
   * needs it as text: replaying the structured history is what the provider
   * rejects when the request declares no tools.
   */
  const btwMessages = (session) => buildTranscript(snapshotMessages(session), { maxChars: 200_000 });

  const btwPrompt = (session, question) => [
    `<conversation>\n${btwMessages(session).text}\n</conversation>`,
    buildSideThread(btwThreads.get(session.id)),
    `<question>\n${question}\n</question>`
  ].filter((part) => part.length > 0).join("\n\n");

  /**
   * One side question end to end: route, prompt, request, thread memory.
   * Shared by the `/btw` handler and the card's follow-up route.
   */
  const runBtw = async (session, question, { signal, onDelta } = {}) => {
    const llm = getService("llm");
    if (llm === undefined || typeof llm.stream !== "function") {
      throw new Error("侧路请求需要 llm 服务，但宿主里没有挂载。");
    }
    const route = resolveRoute(session);
    if (typeof route?.provider !== "string" || typeof route?.model !== "string") {
      throw new Error("这次会话还没有请求记录，无法确定用哪个模型。");
    }
    const answered = await askSideModel(llm, {
      provider: route.provider,
      model: route.model,
      system: BTW_SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [{ type: "text", text: btwPrompt(session, question) }]
      }],
      sessionId: session.id,
      signal,
      onDelta
    });
    const answer = answered.finishKind === "max-tokens"
      ? `${answered.text}\n\n（回答达到输出长度上限，已截断）`
      : answered.text;
    rememberBtw(session.id, question, answer);
    return answer;
  };

  /**
   * POST /handoff/ask — the card's follow-up input.
   *
   * The client used to dispatch `/btw` through `remote.commands`, which needs
   * the `remote.commands` service injected on the client half; when that wiring
   * was missing the click did nothing at all. A plain route keeps the follow-up
   * inside this plugin: one POST in, the same activity slot out.
   */
  const askRoute = async (req, res) => {
    const reply = (status, payload) => {
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      res.end(JSON.stringify(payload));
    };
    if (req.method !== "POST") return reply(405, { error: "POST only" });
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      return reply(error.statusCode ?? 400, { error: error.message });
    }
    const sessionId = typeof body?.session === "string" ? body.session : "";
    const question = typeof body?.question === "string" ? body.question.trim() : "";
    if (sessionId.length === 0 || question.length === 0) {
      return reply(400, { error: "session and question are required" });
    }
    const session = ctx.sessions.get(sessionId);
    if (session === undefined) return reply(404, { error: "unknown session" });
    if (activity.get(sessionId)?.status === "running") {
      return reply(409, { error: "another side request is still running" });
    }
    const entry = activity.begin(sessionId, { kind: "btw", title: "旁问", question });
    const controller = new AbortController();
    activity.track(sessionId, controller);
    void runBtw(session, question, {
      signal: controller.signal,
      onDelta: (text) => activity.update(sessionId, entry.id, { text })
    })
      .then((answer) => activity.finish(sessionId, entry.id, "done", { text: answer }))
      .catch((error) => activity.finish(sessionId, entry.id, "error", {
        text: error instanceof Error ? error.message : String(error)
      }));
    return reply(200, { ok: true, activity: entry });
  };

  const describeHandoff = (result, modeText) =>
    `已交接（${modeText}）：会话 ${result.sessionId} 位于工作区「${result.workspaceTitle}」(${result.workspacePath})` +
    (result.workspaceCreated === true ? "（新工作区）" : "") +
    "。原会话保持不变。";

  const registerCommands = () => {
    const commands = (() => {
      try { return ctx.get("commands", false); } catch { return undefined; }
    })();
    if (commands === undefined || typeof commands.register !== "function") return [];
    const makeDefinition = (history) => {
      const commandName = history === "full" ? "handoff" : "handoff-summary";
      const modeText = history === "full" ? "复制完整历史" : "仅摘要";
      return {
        name: commandName,
        description:
          `交接当前会话（${modeText}）到另一个工作区：用自然语言说明去哪、简报重点写什么`,
        input: { hint: "<自然语言：交接去哪里、简报重点>" },
        async handler(invocation) {
          const { agent, rawInput, signal } = invocation;
          const request = String(rawInput ?? "").trim();
          const sessionId = agent?.session?.id ?? agent?.id;
          const controller = getService("sessionController");
          if (controller === undefined || typeof controller?.prompt !== "function" || typeof sessionId !== "string") {
            return { kind: "error", text: "handoff: 会话控制器不可用，无法发起交接。" };
          }

          // The side request uploads the whole conversation, so it must not run
          // inside the handler: the composer would hold the draft until it lands.
          const plan = await planSideHandoff({ agent, sessionId, request, history });
          if (plan !== undefined) {
            const placeholder = `正在生成简报并交接（${modeText}）…`;
            const entry = activity.begin(sessionId, {
              kind: "handoff",
              title: `交接简报（${modeText}）`,
              phase: "正在写简报…",
              target: plan.target
            });
            const scheduled = scheduleLateResult(invocation, placeholder, async (lateSignal) => {
              try {
                const { result } = await executeSideHandoff(plan, {
                  agent,
                  sessionId,
                  request,
                  history,
                  signal: lateSignal,
                  onBriefDelta: (text) => activity.update(sessionId, entry.id, { phase: "正在写简报…", text }),
                  onPhase: (phase) => activity.update(sessionId, entry.id, { phase })
                });
                const text = describeHandoff(result, modeText);
                activity.finish(sessionId, entry.id, "done", { phase: "", text });
                return text;
              } catch (error) {
                activity.finish(sessionId, entry.id, "error", {
                  phase: "",
                  text: error instanceof Error ? error.message : String(error)
                });
                throw error;
              }
            }, {
              onController: (controller) => activity.track(sessionId, controller),
              failurePrefix: `交接失败（${modeText}）`
            });
            if (scheduled) return { kind: "success", text: `${placeholder}完成后会更新这条结果。` };
          }

          try {
            await controller.prompt(
              {
                requestId: randomUUID(),
                sessionId,
                mode: "queue",
                content: [{ type: "text", text: buildInstructionText({ request, history }) }]
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
            text: `已提交交接请求（${modeText}）。Agent 会先确定目标工作区、写好简报，再创建新会话。`
          };
        }
      };
    };
    return [commands.register(makeDefinition("full")), commands.register(makeDefinition("summary"))];
  };

  /**
   * `/btw` — a side question answered over the same snapshot, reusing the same
   * primitive as the brief. The answer comes back as the command's result: no
   * agent turn, no event appended, nothing added to this conversation's memory.
   */
  const registerBtw = () => {
    const commands = (() => {
      try { return ctx.get("commands", false); } catch { return undefined; }
    })();
    if (commands === undefined || typeof commands.register !== "function") return [];
    return [commands.register({
      name: "btw",
      description: "旁问：基于当前会话上下文问一句，答案即时返回，不写进会话记忆，也不开启回合",
      input: { hint: "<问题>" },
      async handler(invocation) {
        const { agent, rawInput } = invocation;
        const question = String(rawInput ?? "").trim();
        if (question.length === 0) return { kind: "error", text: "用法：/btw <问题>" };
        const llm = getService("llm");
        const session = agent?.session;
        if (llm === undefined || typeof llm.stream !== "function" || session === undefined) {
          return { kind: "error", text: "btw: 这个 dsh 版本没有可用的 llm 服务，无法旁问。" };
        }
        const route = resolveRoute(session);
        if (typeof route.provider !== "string" || typeof route.model !== "string") {
          return { kind: "error", text: "btw: 这次会话还没有请求记录，无法确定用哪个模型。" };
        }
        const placeholder = "旁问中…";
        const entry = activity.begin(session.id, { kind: "btw", title: "旁问", question });
        const scheduled = scheduleLateResult(invocation, placeholder, async (signal) => {
          try {
            const answer = await runBtw(session, question, {
              signal,
              onDelta: (text) => activity.update(session.id, entry.id, { text })
            });
            activity.finish(session.id, entry.id, "done", { text: answer });
            return answer;
          } catch (error) {
            activity.finish(session.id, entry.id, "error", {
              text: error instanceof Error ? error.message : String(error)
            });
            throw error;
          }
        }, {
          onController: (controller) => activity.track(session.id, controller),
          failurePrefix: "旁问失败"
        });
        if (!scheduled) {
          // No command id (an adapted caller): answer inline, accepting the wait.
          try {
            const answer = await runBtw(session, question);
            return { kind: "success", text: answer };
          } catch (error) {
            return { kind: "error", text: `btw: ${error instanceof Error ? error.message : String(error)}` };
          }
        }
        return { kind: "success", text: `${placeholder}（答案会更新在这条结果里）` };
      }
    })];
  };

  /**
   * The Client overlay polls this route. It is optional on purpose: a host
   * without `webServer` (headless, tests) keeps the command cards and loses
   * only the live panel.
   */
  const registerActivityRoute = () => {
    const registered = [];
    try {
      ctx.inject(["webServer"], (child) => {
        registered.push(child.effect(() => child.webServer.register({
          kind: "exact",
          path: "/handoff/activity",
          handler: createActivityRoute(activity)
        }), "handoff activity route"));
        registered.push(child.effect(() => child.webServer.register({
          kind: "exact",
          path: "/handoff/ask",
          handler: askRoute
        }), "handoff ask route"));
      });
    } catch (error) {
      log.warn?.(`dsh-handoff: activity route unavailable: ${String(error)}`);
    }
    return registered;
  };

  const disposers = [
    ctx.tools.register(handoffTool),
    ...registerCommands(),
    ...registerBtw(),
    ctx.on("session/event", (session, event) => {
      if (event?.type === "turn/end") void settleMove(session);
      if (event?.type === "command/done") {
        // The executor's settlement landed; the late answer may now replace it.
        const record = lateResults.get(String(event.data?.commandId));
        if (record !== undefined && record.session === session) {
          record.settled = true;
          flushLateResult(String(event.data.commandId));
        }
      }
    })
  ];
  disposers.push(...registerActivityRoute());
  disposers.push(() => {
    for (const record of lateResults.values()) record.controller?.abort();
    lateResults.clear();
    activity.dispose();
  });
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
