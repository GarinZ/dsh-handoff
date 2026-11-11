# 会话日志的两条硬约束

DSH 加载会话时不会「尽量修复」：`SessionLogScanner.finish()` 在读出全部事件后直接调
`assertReleasedV4Relationships(artifact, KNOWN_SESSION_EVENT_TYPES)`
（`@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js`），任何一条关系违规都会抛
`SessionFormatError`，整个会话在侧边栏里就打不开了，也没有自动修复入口（只有尾部撕裂会截断恢复）。

插件往别人的会话里写事件（本插件的摘要是唯一例子），必须守住下面两条。0.6.2 两条都踩了。

## 一、`turn` 必须由开回合的那一方连续编号

读取器的规则（`@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js:747`）：

```js
if (this.turn !== null || data["turn"] !== this.nextTurn)
  throw new SessionFormatError("turn/start does not open the expected turn");
```

`nextTurn` 从 1 开始，每遇到 `turn/end` 才 +1。所以日志里的回合序列必须是
`1, 2, 3, …`，且同一时刻只能有一个回合打开。

**回合号属于 agent loop，不属于插件。** loop 打开回合时用的是自己缓存的计数器
（`@deepseek-ai/dsh-agent-loop/lib/index.js:724` 起）：

```js
const turn = phase.turn + 1;
this.session.append("turn/start", { turn });
phase.turn = turn;
```

而这个 `phase.turn` 是 loop 被构造时从日志里读出来的一次性快照
（同文件 `:1526`）：

```js
const lastTurn = loopCtx.agents.turnBoundaryOf(session).lastTurn;
this.phase = { kind: "idle", lastTurn };
```

于是有一个反直觉的后果：**插件在 agent 创建之后补写的 `turn/start`，loop 根本看不见。**
用户发第一条消息时 loop 仍会写 `turn/start {turn: 1}`，日志里出现两个 `turn: 1`，
读取器判定整份日志损坏。0.6.2 的 `appendBrief` 正是这样写的，11-06 的三个会话
（`session-6662566f` / `session-b9d559ac` / `session-f1646346`）因此全部打不开。

## 二、surface 的第一个节点必须是 loop 的 `system/message`

`foldSurface`（`@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js:594`）：

```js
if (event.type === "system/message" && this.surface.length > 0 && this.protectedHead === void 0)
  throw new SessionFormatError("system/message requires a protected first surface head");
```

`protectedHead` 只在 `system/message` 是第一个 append 进 surface 的节点时才被设置。
换句话说：**谁先往 surface 上放消息，谁就决定了这个会话还能不能有系统提示。**
loop 的回合第一步就是写 `system/message`，所以任何「先放简报」的写法都会把后续的
`system/message` 变成违规 —— 这就是只有修好回合号之后才暴露出来的第二个错误。

反过来，`user/message` 本身**不要求** turn/step（`STEP_EVENT_TYPES` 只有
`system/message` / `developer/message` / `assistant/attempt`），所以在**已有 surface 头**
的 fork 会话上追加一条简报是合法的 —— `appendBrief` 现在只做这一件事。

## 正确做法：让 loop 自己开这个空回合

仅摘要交接需要一个已关闭的回合，会话才会离开 `sessionListMetadata.blank`
（`dsh-api-session-controller`：`blank: state.blank && event.type !== "turn/start"`），
但回合不能自己写。当前实现（`lib/visible-turn.js`）：

1. `controller.prompt` 把简报当普通消息入队；
2. 一次性 `agent/pre-step` 钩子在该回合 step 1 触发，把 claim 到的消息重新
   `inbox.append("next-step", message)`，然后返回 `{ kind: "enter", messages: [] }`；
3. loop 自己的规则（`dsh-agent-loop/lib/index.js` 的 `turn()`：
   `if (phase.step === 0 && decision.messages.length === 0) { turnEnds = { kind: "completed" }; return false; }`）
   立刻以 `completed` 关闭回合 —— 不建 step、不调模型、不跑工具。

要点：

- 钩子必须按 `agent.id === sessionId` 过滤，否则会劫持别的会话；
- 消息要放回 `next-step` 而不是 `next-turn`：下一次 `claim` 会把 `next-step` 的全部消息
  和用户那条 `next-turn` 一起取走，简报因此和用户的第一条真实消息进入同一个请求，
  不会单独变成一个回合；
- 空回合返回 `false` 后驱动立即停下（`while (await this.turn())`），inbox 里的简报不会
  在 idle 时被自动消费；
- 等 `turn/end`（按 `session/event`、`data.turn` 匹配）确认回合关闭；超时后要摘掉钩子，
  否则它会埋伏到下一个回合上。

## 排查：日志坏了怎么定位

1. 报错串即定位器：`turn/start does not open the expected turn` 是回合号问题，
   `system/message requires a protected first surface head` 是 surface 头问题。
2. 解压日志（多帧 zstd，必须解全部帧；Node 的 `zlib.zstdDecompressSync` 只解第一帧）：

   ```bash
   python3 -c "import zstandard,sys;sys.stdout.write(zstandard.ZstdDecompressor().stream_reader(open(sys.argv[1],'rb')).read().decode())" \
     ~/.dsh/sessions/<workspace>/<session>/session.v4.jsonl.zstd > /tmp/s.jsonl
   ```

   注意按 `\n` 切行，不要用 Python 的 `splitlines()`（会按 `\u2028` 等字符切断记录）。
3. 打印 `turn/start` / `turn/end` 序列，找第一个不连续的位置；surface 问题看第一条
   `surfaceOp:"append"` 的消息是不是 `system/message`。
4. 修复时**不要手写回合**：按 loop 的编号规则重排 `data.turn`，把简报挪到
   `system/message` 之后，再按新顺序重编号 `seq` 并同步所有引用字段
   （`throughSeq` / `sourceEventSeqs` / `messageSeqs` / `startSeq` / `endSeq` 等）。
   改完用真实加载器复验：`sessionFormatCatalog.createRestore(header, { recovery: "strict" })`
   逐行 `decodeRow`，`finish()` 后调 `assertReleasedV4Relationships`。

## 事故记录

| 版本 | 提交 | 症状 | 修复 |
| --- | --- | --- | --- |
| 0.6.2 | `a216c2e` | 仅摘要交接后手写 `turn/start {turn:1}`；同一进程内再发消息即产生重复 turn 1，会话永久打不开 | `3ea125e` 改为 loop 驱动空回合（见上） |

教训：**插件可以读会话、可以追加不需要回合的消息，但不能代替 loop 写回合边界**；
凡是「为了某个投影好看」而补写生命周期事件的想法，先去读读取器的校验函数。
