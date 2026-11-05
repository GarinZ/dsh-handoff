# dsh-handoff

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的**会话交接插件**：Agent 在对话里就能把当前会话交接到另一个工作区。新会话在目标工作区里**热创建**（不重启、不刷新），并带着一份交接简报。

交接有两种历史策略：

| 模式 | `history` | 新会话里有什么 | 什么时候用 |
| --- | --- | --- | --- |
| **全文复制**（默认） | `full` | 完整事件历史 + 交接简报 | 新会话需要精确上下文，且源会话还健康 |
| **仅摘要** | `summary` | 只有交接简报 | 源会话已经很大、上下文快撑爆，或用了不支持主动压缩的插件 |

原会话始终保持不变（`mode: "copy"` 时）。

不需要点按钮，也不需要退出重开——你对 Agent 说一句：

> 把这个会话交接给 ~/Project/foo，新会话里写清楚我们做到哪了

它就会调用 `handoff_session` 工具，在 `~/Project/foo` 里生成一个新会话。也可以直接敲 `/handoff` 或 `/handoff-summary`，由插件向同一个模型发一次**侧路请求**把简报写出来，再创建会话。

## 它解决什么

手工「换个工作区继续」通常会丢三件事：历史、结论、下一步。复制文件不会带上对话；新开一个空会话等于让模型从零开始；把整段记录粘进输入框既超长又失真。

dsh-handoff 用 DSH 自己的能力做三件事：

1. **fork** — `sessionController.fork()` 把当前会话的事件前缀复制成一个独立的新会话（不写 `parentSession`，所以侧栏和可恢复集合都认它）；
2. **relocate** — 把新会话的存储迁到目标工作区：重写日志头行的 `cwd`、重绑活动写句柄、切换工作区账本。全程不重启；
3. **brief** — 把交接简报追加成新会话的第一条消息。简报按固定六节骨架写（目标 / 决策 / 已完成 / 剩余 / 关键上下文 / 下一步），可以由模型在工具调用里写，也可以由插件用一次侧路请求独立生成。

### 为什么需要「仅摘要」

fork 是**事实复制**，不是压缩：源会话如果已经被上下文压力拖到边缘，复制出来的会话会继承同样的压力。最典型的例子是同装了不做主动 compact 的上下文插件——源会话压不下去，新会话同样压不下去，于是「交接」只是把一个快废掉的会话再复制一份。

`history: "summary"` 于是干脆不复制事件：直接在目标工作区新建一个空白会话，把简报写进去。新会话的上下文压力从零开始，代价是丢掉了原始对话里的细节（工具输出、文件内容、原话）。

## 安装

```bash
# 从 npm
dsh plugin --profile <profile> add @garinz/dsh-handoff

# 或直接从 GitHub
dsh plugin --profile <profile> add github:GarinZ/dsh-handoff
```

从本地检出的源码安装：

```bash
dsh plugin --profile <profile> add /path/to/dsh-handoff
# 或在该目录里
dsh plugin --profile desktop add .
```

宿主半热加载，装完即可用；不需要客户端插件，因此也不用刷新页面。

> 仓库：<https://github.com/GarinZ/dsh-handoff> · npm：<https://www.npmjs.com/package/@garinz/dsh-handoff>

## 使用

### 斜杠命令

插件注册了三个命令，输入 `/` 就能看到：

- `/handoff <自然语言>` — 全文复制模式
- `/handoff-summary <自然语言>` — 仅摘要模式
- `/btw <问题>` — 旁问：就当前对话问一句，答案稍后更新在这条命令下，不写进会话记忆

命令本身是**秒回**的：侧路请求要把整段对话发上去，几秒到几十秒不等，如果卡在命令里等，输入框会一直占着草稿、看起来像卡死。所以命令先回一句「旁问中…」/「正在生成简报并交接…」，把输入框让出来；等答案回来，再用同一条命令的结果把它替换掉。

`/handoff` 系列后面跟的是**一段自然语言**，不是路径参数。你同时在里面说清楚两件事：

1. 交接去哪里（可以只写「接手 agent-skills 那边的工作」，让模型自己找）；
2. 简报要重点写什么（下一阶段的重心、必须带过去的决定、不要再碰的东西）。

例如：

```
/handoff-summary 交接给 ~/Project/llm/agent-skills。ESP32 那摊活先放下，下一阶段只做 skill 仓库整理：重点写清楚哪些 skill 已经沉淀、哪些还只是草稿，以及"别自动入库"这条约束。
```

（写成一行即可，命令的输入框是单行的。）

**简报怎么来。** 命令优先走侧路请求：插件取当前会话的消息快照（含 system prompt），追加一条「请按六节骨架写交接简报」的指令，用同一个 provider/model 单独请求一次，拿到简报后直接调用 `handoff_session`。这条请求不开启回合、不往对话里写任何事件，简报也不会被复述到聊天里。只有当目标工作区没能从你这句话里唯一确定（多个标题都像、或干脆没提）、或这次会话还没有一问一答时，才退回「往输入框排一条指令、由模型自己写简报再调工具」的路径。

**简报骨架是固定的六节**，两种模式都一样：

```
## 目标          这一段要达成什么
## 决策          决定了什么 + 为什么（理由比结论重要）
## 已完成        带产物：文件路径、跑过的命令、测试结果
## 剩余          还没做的
## 关键上下文    路径、符号、报错原文、配置值
## 下一步        新会话第一条该做什么
```

写作规则对齐了 oh-my-pi 与 pi-handoff：只用对话里出现过的事实、不臆造路径与行号；关键细节不知道就写「未知」并给出最小验证步骤；用祈使句对下一任说话，不用第一人称；不把「写这份简报」本身写进进度或下一步。

### 旁问 `/btw`

```
/btw 刚才那个 403 是哪个开关没开？
```

它复用简报用的同一个侧路请求原语：快照 + 一句问题 → 一次独立模型调用 → 答案回来时替换掉命令那条「旁问中…」。不开启回合、不写事件、不占会话记忆，也不会打断正在进行的工作，更不会阻塞输入框。如果你已经装了市场里的 BTW 插件（`dsh-btw-plugin`、`dsh-command-btw` 等），可以只用它们的面板，本命令只提供最小的纯文本版本。

### 直接说人话

- 「把这个会话交接给 `/Users/me/Project/new-repo`」
- 「我们换个工作区继续，搬到 `~/work/another-project`，只写总结别复制历史」
- 「hand this off to the agent-skills repo and summarize where we are」

Agent 会调用：

```json
{
  "target": "/Users/me/Project/new-repo",
  "summary": "## 目标\n…\n## 决策\n…\n## 已完成\n…\n## 剩余\n…\n## 关键上下文\n…\n## 下一步\n…",
  "history": "full",
  "title": "可选：给新会话一个能认出来的标题",
  "start_turn": false
}
```

- `target`：工作区绝对路径（或 `~` 开头）、工作区 id、或工作区标题。目录存在但没有工作区记录时会自动注册。这一项由模型根据你的自然语言描述解析，通常不需要你操心。
- `summary`：交接简报，六节骨架，由模型撰写。`history: "full"` 时它是补充；`history: "summary"` 时它是新会话**唯一**的上下文，所以要写全：目标、决定及理由、已完成、待办、要重新打开的文件、验证步骤。
- `history`：`full`（默认）复制完整历史；`summary` 不复制任何事件，只开一个带简报的空白会话。
- `title`：可选，避免目标工作区里出现两个同名会话。
- `start_turn`：为 `true` 时立刻在新会话里跑一轮（它会读到简报并回应）；默认只记录，不消耗模型调用。
- `mode`：`copy`（默认）复制出一个新会话，原会话不动；`move` 把**当前会话本身**在回合结束后迁到目标工作区（id 不变、历史全保留），并在新位置写入简报——适合「这个对话本身就该在那边继续」。`move` 只能搭配 `history: "full"`。

对工作量的兜底：会话里连一问一答都没有时，工具会直接拒绝（`这次会话还没有可交接的对话`），免得留下一个空壳会话。

## 两种模式各自的落盘结果

`history: "full"`：

```
<目标工作区>/…/session-<new>/session.v4.jsonl.zstd
  header.cwd = 目标工作区
  事件 = 源会话的完整前缀 + 简报
```

`history: "summary"`：

```
<目标工作区>/…/session-<new>/session.v4.jsonl.zstd
  header.cwd = 目标工作区
  事件 = 标题 + 简报（没有别的）
```

## 行为细节

- **复制而不是移动**（`mode: "copy"`）：源会话的日志、标题、工作区归属都不变；新会话是独立的一份。
- **热创建**：新会话出现在目标工作区的侧栏里，无需重启 DSH。
- **来源约束**：subagent 会话不能交接；没有记录 `cwd` 的会话不能交接。
- **工作目录**：新会话的 `header.cwd` 是目标工作区路径，因此沙箱根、AGENTS.md、skills 发现都跟着走。
- **损坏保护**：存储迁移先写临时目录、读回校验，再改内存态与账本；任一步失败都会回滚并保留原会话。
- **`mode: "move"`（beta）**：迁移推迟到当前回合结束（`turn/end`）执行，避免在工具调用中途改写正在写入的日志；工具当时只返回 `queued: true`。如果目标路径与当前工作区相同，则只补写简报、不搬文件。

## 已知边界

- 全文模式交接过来的是 **fork 语义**：新会话的 `isSeeded` 为 `true`，历史标记为继承（`session/end-seed`）。它可正常打开、继续对话，但依赖「自身事件」的功能（例如按会话统计 token 用量）会把继承部分算作前人历史。
- 摘要模式的新会话**没有**继承历史，因此也不会有这些问题；反过来说，它只知道简报里写了的东西。
- 侧栏刷新时机由 DSH 客户端决定；工作区账本与日志是即时写好的，个别界面状态可能需要切一下工作区或刷新页面才显示。
- 依赖若干 DSH 内部接口（`sessionPersistence.tracker.writers`、`workspaceRegistry.indexHeader/attachSession`、`commands.register`）。DSH 升级后请先在一个临时会话上验证。

## 兼容性

- 开发与验证环境：DSH `0.2.2-rc.1`（macOS 桌面版），Node 24。
- 需要 hosting 暴露 `sessionController`、`workspaceRegistry`、`sessionPersistence` 三个服务（官方 `dsh-base` 都有）；有 `commands` 服务时才会注册斜杠命令，没有也不影响工具。

## 开发与测试

```bash
npm test        # node --test test/*.test.mjs
```

- `test/relocate.test.mjs` — 存储布局编码（`projectKey` / `encodeSegment`）、头部帧重写、事件帧逐字节保留、重复目标拒绝、同目录 no-op。
- `test/prompts.test.mjs` — 六节骨架、写作规则（不臆造 / 未知标注 / 祈使句 / 机制不可见）、summary 与 full 的模式差异、空请求兜底。
- `test/side-request.test.mjs` — 路由解析、消息计数、侧路请求的文本拼接与错误分支。
- `test/plugin.test.mjs` — 三个命令的注册、`/btw` 的侧路回答与延迟回填、后台交接成功/失败的回填、控制器缺失时的错误返回。

## 许可与致谢

MIT。`lib/relocate.js` 改编自 [dsh-cd](https://github.com/john-walks-slow/dsh-cd)（MIT）的 `dist/relocate.js`；会话存储布局的编码规则（`projectKey` / `encodeSegment`）取自 DSH 的 JSONL 持久化后端，同一份代码也出现在 [dsh-session-manager](https://github.com/hkkz9522/dsh-session-manager)（MIT）中。
