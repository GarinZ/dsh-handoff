# dsh-handoff

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的**会话交接插件**：Agent 在对话里就能把当前会话**完整复制**到另一个工作区，新会话保留全部历史，并附上一份交接简报。原会话原封不动。

不需要点按钮，也不需要退出重开——你对 Agent 说一句：

> 把这个会话交接给 ~/Project/foo，新会话里写清楚我们做到哪了

它就会调用 `handoff_session` 工具，在 `~/Project/foo` 里生成一个新会话。

## 它解决什么

手工「换个工作区继续」通常会丢三件事：历史、结论、下一步。复制文件不会带上对话；新开一个空会话等于让模型从零开始；把整段记录粘进输入框既超长又失真。

dsh-handoff 用 DSH 自己的能力做三件事：

1. **fork** — `sessionController.fork()` 把当前会话的事件前缀复制成一个独立的新会话（不写 `parentSession`，所以侧栏和可恢复集合都认它）；
2. **relocate** — 把新会话的存储迁到目标工作区：重写日志头行的 `cwd`、重绑活动写句柄、切换工作区账本。全程不重启；
3. **brief** — 把你写的交接简报追加成新会话的第一条消息，于是新会话既有完整历史，也有一份能先读的摘要。

## 安装

从 GitHub 直装：

```bash
dsh plugin --profile <profile> add github:GarinZ/dsh-handoff
```

从本地检出的源码安装：

```bash
dsh plugin --profile <profile> add /path/to/dsh-handoff
# 或在该目录里
dsh plugin --profile desktop add .
```

宿主半热加载，装完即可用；不需要客户端插件，因此也不用刷新页面。

> 仓库：<https://github.com/GarinZ/dsh-handoff>

## 使用

直接说人话，例如：

- 「把这个会话交接给 `/Users/me/Project/new-repo`」
- 「我们换个工作区继续，搬到 `~/work/another-project`，写个总结」
- 「hand this off to the agent-skills repo and summarize where we are」

Agent 会调用：

```json
{
  "target": "/Users/me/Project/new-repo",
  "summary": "目标：…\n已决定：…\n已完成：…\n待办：…\n关键文件：…",
  "title": "可选：给新会话一个能认出来的标题",
  "start_turn": false
}
```

- `target`：工作区绝对路径（或 `~` 开头）、工作区 id、或工作区标题。目录存在但没有工作区记录时会自动注册。
- `summary`：交接简报，由模型根据上下文撰写，会作为新会话的第一条消息。
- `title`：可选，避免目标工作区里出现两个同名会话。
- `start_turn`：为 `true` 时立刻在新会话里跑一轮（它会读到简报并回应）；默认只记录，不消耗模型调用。
- `mode`：`copy`（默认）复制出一个新会话，原会话不动；`move` 把**当前会话本身**在回合结束后迁到目标工作区（id 不变、历史全保留），并在新位置写入简报——适合「这个对话本身就该在那边继续」。

## 行为细节

- **复制而不是移动**：源会话的日志、标题、工作区归属都不变；新会话是独立的一份。
- **热创建**：新会话出现在目标工作区的侧栏里，无需重启 DSH。
- **来源约束**：subagent 会话不能交接；没有记录 `cwd` 的会话不能交接。
- **工作目录**：新会话的 `header.cwd` 是目标工作区路径，因此沙箱根、AGENTS.md、skills 发现都跟着走。
- **损坏保护**：存储迁移先写临时目录、读回校验，再改内存态与账本；任一步失败都会回滚并保留原会话。
- **`mode: "move"`（beta）**：迁移推迟到当前回合结束（`turn/end`）执行，避免在工具调用中途改写正在写入的日志；工具当时只返回 `queued: true`。如果目标路径与当前工作区相同，则只补写简报、不搬文件。

## 已知边界

- 交接过来的是 **fork 语义**：新会话的 `isSeeded` 为 `true`，历史标记为继承（`session/end-seed`）。它可正常打开、继续对话，但依赖「自身事件」的功能（例如按会话统计 token 用量）会把继承部分算作前人历史。
- 侧栏刷新时机由 DSH 客户端决定；工作区账本与日志是即时写好的，个别界面状态可能需要切一下工作区或刷新页面才显示。
- 依赖若干 DSH 内部接口（`sessionPersistence.tracker.writers`、`workspaceRegistry.indexHeader/attachSession`）。DSH 升级后请先在一个临时会话上验证。

## 兼容性

- 开发与验证环境：DSH `0.2.2-rc.1`（macOS 桌面版），Node 24。
- 需要 hosting 暴露 `sessionController`、`workspaceRegistry`、`sessionPersistence` 三个服务（官方 `dsh-base` 都有）。

## 许可与致谢

MIT。`lib/relocate.js` 改编自 [dsh-cd](https://github.com/john-walks-slow/dsh-cd)（MIT）的 `dist/relocate.js`；会话存储布局的编码规则（`projectKey` / `encodeSegment`）取自 DSH 的 JSONL 持久化后端，同一份代码也出现在 [dsh-session-manager](https://github.com/hkkz9522/dsh-session-manager)（MIT）中。
