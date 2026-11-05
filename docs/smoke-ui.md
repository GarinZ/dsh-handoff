# 浏览器冒烟流程

单元测试只覆盖宿主半的编排：它们用假的 `ctx` 和假的 `remote`，**永远碰不到真实浏览器**。凡是改动 `client.js`、`/handoff/activity`、`/handoff/ask` 或槽位注册，都必须按这份流程在真浏览器里跑一遍再提交。

## 为什么不能直接用桌面 App

桌面 App 的 Web 壳走一次性 token（`GET /` 返回 401 `dsh web authentication required`），token 藏在 webview URL 里，拿不到也没法在自动化浏览器里复用；`--profile desktop` 又被 Electron 独占（`error: profile "desktop" is managed exclusively by the Electron application`）。

所以用一个隔离的 `DSH_HOME` 起一个独立宿主，插件软链到工作区源码，改完立即生效。

## 准备

```bash
# 1. 复制一份 profile 和凭据（凭据是明文，收尾必须删）
rsync -a ~/.dsh/profiles /tmp/dsh-smoke/
cp ~/.dsh/.credentials.yaml /tmp/dsh-smoke/.credentials.yaml
mv /tmp/dsh-smoke/profiles/desktop /tmp/dsh-smoke/profiles/smoke

# 2. 软链必须是绝对路径：相对软链复制到 /tmp 后会指向 /tmp/Project
ln -sfn /Users/garin/Project/llm/dsh-handoff \
  /tmp/dsh-smoke/profiles/smoke/node_modules/@garinz/dsh-handoff

# 3. 用和应用同版本的 CLI（全局 dsh 可能是旧版）
npm i --prefix /tmp/dsh-cli2 @deepseek-ai/dsh@0.2.2-rc.1
```

## 起宿主

```bash
DSH_HOME=/tmp/dsh-smoke /tmp/dsh-cli2/node_modules/.bin/dsh \
  --profile smoke --port 60740 --no-open > /tmp/dsh-smoke-host.log 2>&1 &

grep -o 'http://127.0.0.1:60740/?token=[A-Za-z0-9_-]*' /tmp/dsh-smoke-host.log | tail -1
```

改的是宿主半（`index.js`、`lib/`）时先 `pkill -f "dsh --profile smoke"` 再重起；只改 `client.js` 时刷新页面即可（模块按需从磁盘读取，不需要重启）。

## 用 agent-browser 验

```bash
agent-browser open "<上一步的 token URL>"
agent-browser snapshot -i | grep 'textbox "发消息'      # 拿 composer 的 ref
agent-browser fill @e52 "/btw 两个字回答" && agent-browser press Enter
sleep 3
agent-browser eval "document.querySelectorAll('.handoff-card').length"
```

要看的四件事：

1. **命令秒回**：输入框里那一行立刻消失，对话里出现「旁问中…（答案会更新在这条结果里）」。
2. **卡片出现**：2 秒内 `.handoff-card` 数量为 1，标题「旁问」、状态「正在输出…」。
3. **追问可用**：卡片底部输入框打字 → 点「追问」→ 网络里有 `POST /handoff/ask 200`，卡片正文换成新答案。
4. **summary 交接**：`/handoff-summary 交接给 /tmp/handoff-fast-dest，重点写…` → 卡片走「正在写简报… → 正在创建会话… → 完成」，完成后 `/tmp/handoff-fast-dest` 存在，卡片给出 `session-…` 与新工作区名。

回合运行中也要测一次：先发一个要跑十几秒的任务（「从 1 数到 40，每行一个」），趁它还在流式输出时发 `/btw …`，卡片必须照样出现并能被追问。

## 已知坑

- `/plugins/??@garinz/dsh-handoff/client.js` 是组合入口，单包 `/plugins/@garinz/dsh-handoff/client.js` 404 属正常。
- 槽位注册要用 `ctx.slots.inject(name, () => ctx.slots.register(...))`。裸的 `ctx.inject(['slots'], …)` 在部分壳里会时有时无——这正是 0.6.0 里「卡片偶尔不出现」的根因。
- `command/executed` 之后第一次 `GET /handoff/activity` 可能还是上一个请求的槽（或 `idle`），客户端必须留一个几秒的宽限窗口，不能一收到 `idle` 就把卡片关掉。
- 页面刷新后 `localStorage["dsh-handoff:activity-session"]` 会残留；只有槽仍 `running` 时才恢复卡片。
- `agent-browser` 的 `@eNN` ref 在页面重渲染后会变，每次操作前重新 `snapshot -i`。
- ref 过期时 `fill` 可能写进卡片里的追问框，看着像「命令没执行」，实际是发了一次旁问。

## 收尾

```bash
pkill -f "dsh --profile smoke"
rm -rf /tmp/dsh-smoke /tmp/handoff-fast-dest /tmp/handoff-smoke-dest
```

`/tmp/dsh-smoke` 里有明文的 API 凭据副本，**必须删**。
