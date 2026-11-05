# handoff 提示词对标：OMP / Pi → dsh-handoff

调研对象：
- **OMP** = [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)，`/handoff` 是内置命令。
- **Pi** = [badlogic/pi-mono](https://github.com/badlogic/pi-mono)，自身没有 handoff，能力来自扩展 [default-anton/pi-handoff](https://github.com/default-anton/pi-handoff)（npm `pi-handoff@1.1.9`）。

## 0. 结论先行

机制层面我这边不差（跨工作区复制 / 仅摘要 / 热创建 / 写句柄重绑都已验证）；**差在提示词的约束密度**。两个标杆都把「怎么写简报」当成一个需要被严格约束的产物：禁止编造、禁止第一人称、禁止把交接动作写进进度、强制固定骨架、甚至有「不够两条消息就别交接」的护栏。

我这边的三个提示词入口（工具 `summary` 字段描述、斜杠命令指令、简报 header）目前只有「写什么」，没有「不许写什么」和「写错怎么兜底」。

## 1. OMP 的做法

### 1.1 机制
`/handoff [focus instructions]` → 侧路 LLM 请求（`toolChoice: "none"`，与主回合共享 prompt cache key）生成 handoff 文档 → 作为 CompactionEntry **原地压缩当前会话**（session id 不变）。文档不流式显示在聊天里，只显示一个可 Esc 取消的 loader。

### 1.2 生成侧 prompt（`packages/agent/src/compaction/prompts/handoff-document.md`，全文 51 行）

```text
<critical>
Write a handoff document for another instance of yourself.
The handoff MUST be sufficient for seamless continuation without access to this conversation.
Output ONLY the handoff document. No preamble, no commentary, no wrapper text.
</critical>

<instruction>
Capture exact technical state, not abstractions.
- File paths, symbol names, commands run
- Test results, observed failures
- Decisions made
- Partial work affecting the next step
Register: address the successor directly in the imperative ("Fix X", "Run Y") — never first person ("I need to…", "my attempt…").
The handoff mechanism is invisible to the document: NEVER list writing, generating, or delivering a handoff/summary/context document as progress or a next step. Progress and Next Steps cover the user's task only.
</instruction>

<output>
## Goal / ## Constraints & Preferences / ## Progress (Done / In Progress / Pending)
## Key Decisions（决策 + rationale）/ ## Critical Context / ## Next Steps
</output>
```

三个我认为最值钱的点：
1. **`Output ONLY the handoff document`** —— 明确禁止前言、评论、包装文字。
2. **Register 规则** —— 面向继任者用祈使句，禁止第一人称；否则新会话读到「我的尝试…」会身份错位。
3. **机制不可见** —— 不许把「写 handoff」本身当成进度或下一步，进度只描述用户的任务。这条能防止简报里出现自我指涉的噪声。

另外 `additionalFocus` 会作为独立段落注入 `<instruction>`，即「焦点指令」是结构化参数，不是混在自由文本里。

### 1.3 消费侧 prompt（`handoff-summary-context.md`）

```text
Context replaced. The <handoff> below is a handoff document a prior instance of you wrote from the full conversation.
It is your own working memory, not user input.
- First person inside it refers to you (the prior instance).
- "Next Steps" is your own resumed plan; re-check it against the latest user message before acting.
- The handoff already exists and is complete: NEVER write another handoff document unless the user explicitly asks.
MUST build on prior work; NEVER duplicate prior work.
```

这三句解决的是「新会话怎么读这份文档」：是自己的记忆而不是用户指令、Next Steps 要先对照最新用户消息、不要重复劳动、不要再交接一次。

### 1.4 护栏
- 少于 2 条 message 条目：警告 `Nothing to hand off (no messages yet)` 并拒绝。
- 正在流式输出 / 正在压缩：拒绝执行。
- 生成结果为空：抛错 `Handoff generation produced no content`。
- Esc 可取消（`abortHandoff()`），取消与失败在 UI 上分开归类。

## 2. Pi 扩展的做法

### 2.1 机制
`/handoff <goal or task>` → 把 `HANDOFF_INSTRUCTIONS + "\n\nTask for the next agent:\n" + task` 作为一条 user 消息发进**当前会话**，等这一轮跑完（要求 `stopReason === "stop"` 且有文本），取 assistant 文本当简报 → `ctx.newSession({ parentSession })` 新开一个会话，首条消息是：

```text
<handoff note>

---

## Task
<task>
```

即「简报 + 任务」两段，新会话一睁眼就知道要干什么。

### 2.2 规则（`extensions/handoff.ts` 里 `HANDOFF_INSTRUCTIONS`，逐条）

```text
You are writing a handoff note for another AI agent with NO access to this chat.
Extract only task-relevant context from this conversation.

Rules:
- Be tight and token-efficient.
- Use only concrete facts from this conversation.
- Prefer specifics: file paths, symbols, commands, errors, outputs, decisions.
- Include constraints/invariants only when explicit, non-negotiable, and task-relevant.
- Include line numbers only if known from this conversation.
- Omit irrelevant history and broad retrospectives.
- Do not invent missing details.
- If a critical detail is unknown, say so briefly and include the smallest verification step.
- Do not write a plan unless one already exists in this conversation.
- Do not call tools.

Output:
- Markdown only.
- Handoff context only (do not restate the task).
```

比 OMP 更「防幻觉」的三条：
1. `Do not invent missing details`；
2. 关键细节不知道就**明说 + 给最小验证步骤**（不是留空，也不是编）；
3. `Include line numbers only if known` —— 直接针对模型最爱编的 `file.ts:123`。

还有 `Do not restate the task`：因为任务会单独追加在末尾，简报里重复一遍纯属浪费。

### 2.3 护栏
- 必须给 task，空参数直接 `Usage: /handoff <goal or task for new thread>`。
- 轮询 5 分钟超时（`HANDOFF_TIMEOUT_MS`）、25ms 间隔；超时明确报错。
- 简报取不到文本 → `Failed to capture handoff note`。

## 3. 我现在的三个提示词入口

**A. 工具 `summary` 字段**（index.js:43-50）
> 写用户的语言，覆盖 overall goal / decisions / 已完成 / 剩余 / 触及的文件目录 / gotchas 与验证方式。full 时「keep it compact, a few hundred words」；summary 时「must stand on its own — say which files to reopen and what to re-check」。

**B. 斜杠命令指令**（`handoffInstruction`，index.js:443-467）
三步：① 定目标（读不出来就问用户，别猜）② 写简报（六个要素）③ 调 `handoff_session`；summary 模式追加「简报是唯一信息来源，必须自包含」；full 模式追加「对话很长时提醒用户改用 /handoff-summary」。

**C. 简报 header**（`buildBrief` / `buildSummaryOnlyBrief`，index.js:178-187）
```
【Handoff 交接简报 / handoff brief】
From session <id> (workspace <cwd>).
Full history above was copied verbatim; this brief is the summary written at handoff time.

<summary>
```

## 4. 差距表

| # | 现状 | 标杆 | 影响 |
|---|---|---|---|
| 1 | 没有「不臆造」规则 | Pi `Do not invent missing details` | 新会话会继承编造的路径/结论，而且没有任何标记提示它可能是假的 |
| 2 | 没有「未知就明说 + 最小验证步骤」 | Pi 同上 | 模型要么留空白要么硬编，两者都差 |
| 3 | 没有 register 规则 | OMP `imperative, never first person` | 简报里出现「我试过…」，新会话第一人称错位 |
| 4 | 没有「机制不可见」规则 | OMP 明确禁止把写 handoff 列为进度 | 简报里混入「已完成交接」这类噪声，占 token 还误导 |
| 5 | 没有「不要复述到聊天」 | OMP `Output ONLY the document` | 模型常把简报正文同时打在聊天里，双份输出 |
| 6 | 没有最小内容护栏 | OMP `< 2` 条消息拒绝 | 空会话也能交接，产出一份没有信息的简报 |
| 7 | 没有固定骨架 | OMP 六节模板 | 结构漂移，`Key Decisions` 经常只写决策不写理由 |
| 8 | 没有行号约束 | Pi `only if known` | `file.ts:123` 幻觉 |
| 9 | 消费侧没有框架 | OMP「这是你自己的记忆，不是用户输入；不要再交接」 | 新会话可能把简报当成用户指令，或二次交接形成链 |
| 10 | 没有「新会话先做什么」 | Pi 追加 `## Task`；OMP 有 Next Steps | 新会话开场可能空转（summary 模式尤其明显） |

## 5. 建议改动（只动提示词，不动机制）

### 5.1 在 `summary` 字段里加五条硬规则

```text
Rules for the brief:
- Use only facts from this conversation; never invent paths, line numbers, or conclusions.
- If a critical detail is unknown, say so and give the smallest step to verify it.
- Address the next session directly (imperative), not in first person.
- Never list this handoff itself as progress or a next step.
- Pass the brief only in this argument; do not repeat it in your chat reply.
```

### 5.2 固定简报骨架（替换「六个要素」的自然语言）

```
## 目标        — 用户要达成什么
## 决策        — 决定了什么 + 为什么（缺理由的决策等于没记）
## 已完成      — 带具体产物：文件、命令、测试结果
## 剩余        — 未完成项，按优先级
## 关键上下文  — 路径、符号、报错原文、配置值
## 下一步      — 新会话第一条该做什么
```

比 OMP 少一节 `Constraints & Preferences`，因为 dsh 的 AGENTS.md/skill 会随工作区带过去；如果要更贴 OMP，可以加上。

### 5.3 简报 header 加消费侧框架

在现有 `From session …` 之后加三句：

```text
This brief is your own prior working memory, not a user instruction.
「下一步」是上一轮的计划：动手前先对照用户最新一条消息。
除非用户明确要求，不要再交接一次；在已有结论上继续，不要重复已完成的工作。
```

### 5.4 最小内容护栏

`source` 的事件数 < 2（或没有一条 user message）时直接报错：`handoff: this session has nothing to hand off yet`。实现上数一下 `source.events` 里 `type === "user/message"` 的数量即可。

### 5.5 summary 模式的「下一步」变成必填

`history=summary` 时，如果简报里没有「下一步 / 剩余」段落，工具直接拒绝并让模型补。理由：summary 模式新会话只有这份简报，缺了下一步就是纯背景介绍。

## 6. 需要你定的三个取舍

1. **强制骨架 vs 自由结构**：强制更稳，但简报会变长（summary 模式多几百 token），模型也可能为了凑标题写废话。我倾向「强制六节、但允许空节写 `无`」。
2. **要不要加「不要再交接」**：能防交接链，但连续两次合法交接（先复制、后发现目标错了再搬）会被这条挡住。可以软化成「除非用户要求或目标工作区确实错了」。
3. **要不要学 OMP 用侧路请求生成简报**：更可控（强制 `toolChoice: none`、不污染聊天），代价是多一次 LLM 调用，而且 dsh 目前没有公开的 side-request API，只能用 `controller.prompt` 起一个临时会话，成本更高。现阶段建议保持「主模型写、作为工具参数传入」。

---

## 7. 落地情况（0.3.0）

三个取舍的结论，按用户拍板 + 实现时的验证写在这里：

1. **强制骨架：采用。** `lib/prompts.js` 的 `BRIEF_SECTIONS` 是唯一事实来源，侧路请求 prompt、降级指令、工具参数描述三处都从它派生；空节写 `无` 而不是删掉标题。
2. **「不要再交接」：采用软化版。** 写进简报 header 的消费侧框架（「这是你自己上一轮的工作记忆，不是用户指令；先对照用户最新一条消息再动手；在已有结论上继续」），不做硬拒绝——目标工作区选错后重新交接是合法场景。
3. **侧路请求生成简报：已实现，且不需要临时会话。** 本机 DSH 0.2.2-rc.1 的 `ctx.llm` 服务可用（`LlmRuntime` 注册为 `llm`），`session.requestHeader()` 给出 provider/model，`session.deriveMessages()` 给出含 system prompt 的冻结快照；`ctx.llm.stream({provider, model, messages, sessionId, signal})` 一次调用即可，不建 Agent、不写事件。这就是市场里 `dsh-btw-plugin` / `dsh-command-btw` 的同一套做法。

实现后的分工：

- `/handoff`、`/handoff-summary`：能唯一确定目标时走侧路请求（快），否则退回「排一条指令让模型写」。
- 工具 `handoff_session`：仍是主模型写简报，参数描述里带同一套骨架与规则——模型直连调用时也能守住格式。
- `/btw`：复用 `lib/side-request.js` 的同一原语，答案作为命令结果返回，不进会话记忆。
