/**
 * Client half of dsh-handoff — the live progress card for side requests.
 *
 * The command card in the transcript is the archive: it appears in the
 * conversation flow, which is exactly where nobody looks while a turn is
 * streaming. The market BTW plugins (`dsh-command-btw`, `dsh-btw-plugin`) solve
 * this with a fixed overlay fed by a host route; this card does the same:
 *
 *   Host:    GET /handoff/activity?session=<id>  →  the running activity slot
 *            GET /handoff/activity?session=<id>&cancel=1  →  abort it
 *   Client:  a fixed card above the composer, polling while something runs.
 *
 * Both `/btw` and the `/handoff*` fast path write into that slot, so the card
 * shows "answer streaming" or "brief → creating session" even mid-turn.
 */
window.__ModuleLoader__.load({
  id: '@garinz/dsh-handoff',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState, useSyncExternalStore } = React

    // The composer establishes a containing block (backdrop-filter and friends),
    // so a position:fixed card rendered inside it would anchor to the composer
    // instead of the viewport. Portal to the body when react-dom is reachable.
    let ReactDOM = null
    try {
      ReactDOM = require('react-dom')
    } catch {
      // No react-dom in this shell: the card still renders, anchored to whatever
      // containing block it lands in.
    }

    let MarkdownText = null
    try {
      MarkdownText = require('@deepseek-ai/dsh-client-ui-primitives').MarkdownText ?? null
    } catch {
      // The primitives module is present in the Web deployment; a plain-text
      // fallback keeps the card readable if it ever is not.
    }

    const POLL_MS = 700
    const POLL_TIMEOUT_MS = 600_000
    const STORAGE_KEY = 'dsh-handoff:activity-session'
    const COMMANDS = new Set(['btw', 'handoff', 'handoff-summary'])

    /** Panel state. Shared with the component through useSyncExternalStore. */
    const store = {
      state: { sessionId: '', activity: null, open: false },
      listeners: new Set(),
      get() {
        return store.state
      },
      set(patch) {
        const next = { ...store.state, ...patch }
        // useSyncExternalStore only re-renders on identity change.
        store.state = next
        for (const listener of store.listeners) listener()
      },
      subscribe(listener) {
        store.listeners.add(listener)
        return () => store.listeners.delete(listener)
      }
    }

    // Filled in by `apply`: a follow-up question is just another slash command,
    // so the card can hand it to the same remote path the composer uses.
    const followUp = { execute: null }

    let pollGeneration = 0

    function poll(sessionId) {
      const generation = ++pollGeneration
      const started = Date.now()
      const tick = () => {
        if (generation !== pollGeneration) return
        fetch(`/handoff/activity?session=${encodeURIComponent(sessionId)}`, { cache: 'no-store' })
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
          .then((activity) => {
            if (generation !== pollGeneration || store.state.sessionId !== sessionId) return
            if (!activity || activity.status === 'idle') {
              if (store.state.activity?.status === 'running') store.set({ activity: null, open: false })
              return
            }
            store.set({ activity, open: true })
            if (activity.status === 'running' && Date.now() - started < POLL_TIMEOUT_MS) setTimeout(tick, POLL_MS)
          })
          .catch(() => {
            // A transient fetch failure (host restarting) must not kill the card.
            if (generation === pollGeneration && Date.now() - started < POLL_TIMEOUT_MS) setTimeout(tick, POLL_MS * 3)
          })
      }
      setTimeout(tick, 120)
    }

    function failFollowUp(message) {
      const activity = store.state.activity
      if (!activity) return
      store.set({ activity: { ...activity, status: 'error', text: message } })
    }

    function askFollowUp(sessionId, question) {
      const text = String(question ?? '').trim()
      if (text.length === 0) return false
      if (typeof followUp.execute !== 'function') {
        failFollowUp('追问发送失败：客户端没有拿到 remote.commands 服务。')
        return false
      }
      let reply
      try {
        // The line needs its leading slash: the host parses it exactly like a
        // composer submission, and an unknown command is dropped silently.
        reply = followUp.execute(sessionId, `/btw ${text}`)
      } catch (error) {
        failFollowUp(`追问发送失败：${error?.message ?? error}`)
        return false
      }
      Promise.resolve(reply).then((result) => {
        if (result && result.ok === false) {
          failFollowUp(`追问发送失败：${result.error?.message ?? result.error?.code ?? 'unknown error'}`)
        } else if (result && result.value === undefined) {
          failFollowUp('追问没有被接受：宿主里没有可用的 /btw 命令。')
        }
      }).catch((error) => {
        failFollowUp(`追问发送失败：${error?.message ?? error}`)
      })
      // The host replaces the slot; restart the loop so the card follows it.
      poll(sessionId)
      return true
    }

    function cancel(sessionId) {
      if (!sessionId) return
      fetch(`/handoff/activity?session=${encodeURIComponent(sessionId)}&cancel=1`, { cache: 'no-store' }).catch(() => {})
    }

    function formatElapsed(ms) {
      const seconds = Math.max(0, Math.round(ms / 1000))
      if (seconds < 60) return `${seconds}s`
      return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`
    }

    function statusText(activity, now) {
      if (activity.status === 'done') return '已完成'
      if (activity.status === 'error') return '失败'
      // A request that has produced no text yet is still waiting on the model.
      const base = activity.phase || (activity.text ? '正在输出…' : '正在思考…')
      return `${base} ${formatElapsed(now - activity.startedAt)}`
    }

    function ActivityCard() {
      const state = useSyncExternalStore(store.subscribe, store.get)
      const activity = state.activity
      const [, tick] = useState(0)
      const [draft, setDraft] = useState('')

      useEffect(() => {
        if (activity?.status !== 'running') return undefined
        const timer = setInterval(() => tick((value) => value + 1), 500)
        return () => clearInterval(timer)
      }, [activity?.status, activity?.id])

      if (!state.open || !activity) return null

      const now = Date.now()
      const running = activity.status === 'running'
      const isBtw = activity.kind === 'btw'

      const card = h('div', { className: 'handoff-card', key: 'handoff-card' }, [
        h('div', { className: 'handoff-card-head', key: 'head' }, [
          h('span', { className: 'handoff-card-title', key: 'title' },
            `${activity.title || (isBtw ? '旁问' : '侧路请求')}${running ? '' : activity.status === 'error' ? ' · 失败' : ' · 完成'}`),
          h('span', { className: 'handoff-card-status', key: 'status' }, statusText(activity, now)),
          h('button', {
            key: 'close',
            type: 'button',
            className: 'handoff-card-btn',
            title: '关闭',
            onClick: () => store.set({ open: false })
          }, '×')
        ]),
        activity.question
          ? h('div', { className: 'handoff-card-question', key: 'question' }, activity.question)
          : null,
        activity.text
          ? h('div', {
            className: activity.status === 'error' ? 'handoff-card-body handoff-card-error' : 'handoff-card-body',
            key: 'body'
          }, MarkdownText ? h(MarkdownText, { text: activity.text, streaming: running, variant: 'compact' }) : activity.text)
          : running
            ? h('div', { className: 'handoff-card-body handoff-card-waiting', key: 'body' }, '正在等待模型返回…')
            : null,
        isBtw
          ? h('form', {
            className: 'handoff-card-followup',
            key: 'followup',
            onSubmit: (event) => {
              event.preventDefault()
              if (askFollowUp(state.sessionId, draft)) setDraft('')
            }
          }, [
            h('input', {
              key: 'input',
              className: 'handoff-card-input',
              placeholder: '继续追问…',
              value: draft,
              onChange: (event) => setDraft(event.target.value),
              onKeyDown: (event) => {
                // The composer behind the card owns Enter for its own draft.
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.stopPropagation()
                  event.preventDefault()
                  if (askFollowUp(state.sessionId, draft)) setDraft('')
                }
              }
            }),
            h('button', {
              key: 'send',
              type: 'submit',
              className: 'handoff-card-btn handoff-card-send',
              disabled: draft.trim().length === 0
            }, '追问')
          ])
          : null,
        running && isBtw
          ? h('div', { className: 'handoff-card-foot', key: 'foot' }, [
            h('button', {
              key: 'stop',
              type: 'button',
              className: 'handoff-card-btn handoff-card-stop',
              onClick: () => cancel(state.sessionId)
            }, '停止')
          ])
          : null
      ])

      return ReactDOM?.createPortal ? ReactDOM.createPortal(card, document.body) : card
    }

    return {
      inject: ['slots', 'remote'],
      apply(ctx) {
        try {
          const remote = ctx.remote ?? ctx.get?.('remote')
          if (remote?.commands?.execute) {
            followUp.execute = (sessionId, line) => remote.commands.execute(sessionId, line, [])
          }
        } catch {
          // No remote service: the follow-up input simply stays inert.
        }

        ctx.effect(() => {
          const style = document.createElement('style')
          style.textContent = [
            '.handoff-card{position:fixed;right:24px;bottom:96px;width:min(400px,calc(100vw - 48px));',
            'z-index:400;display:flex;flex-direction:column;gap:6px;max-height:52vh;overflow:auto;',
            'padding:10px 12px 10px;border-radius:12px;background:rgba(252,252,253,0.985);',
            'border:1px solid rgba(0,0,0,0.12);box-shadow:0 12px 36px rgba(0,0,0,0.18);',
            'color:#1d1d1f;font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;',
            'font-size:13px;line-height:1.5;}',
            '@media (prefers-color-scheme:dark){.handoff-card{background:rgba(38,38,42,0.985);',
            'border-color:rgba(255,255,255,0.14);color:#f2f2f7;}}',
            '.handoff-card-head{display:flex;align-items:center;gap:8px;}',
            '.handoff-card-title{font-weight:600;white-space:nowrap;}',
            '.handoff-card-status{flex:1 1 auto;text-align:right;font-size:11.5px;opacity:0.6;',
            'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
            '.handoff-card-btn{flex:none;height:22px;min-width:22px;padding:0 6px;border:none;border-radius:6px;',
            'background:none;color:inherit;cursor:pointer;font-size:13px;line-height:1;opacity:0.65;}',
            '.handoff-card-btn:hover{opacity:1;background:rgba(128,128,128,0.16);}',
            '.handoff-card-stop{font-size:12px;}',
            '.handoff-card-question{padding-bottom:6px;border-bottom:1px dashed rgba(128,128,128,0.28);',
            'font-size:12px;font-style:italic;opacity:0.7;white-space:pre-wrap;word-break:break-word;}',
            '.handoff-card-body{overflow:auto;max-height:38vh;user-select:text;-webkit-user-select:text;}',
            '.handoff-card-waiting{opacity:0.6;}',
            '.handoff-card-error{color:#c0392b;}',
            '.handoff-card-foot{display:flex;justify-content:flex-end;}',
            '.handoff-card-followup{display:flex;gap:6px;border-top:1px solid rgba(128,128,128,0.22);padding-top:8px;}',
            '.handoff-card-input{flex:1 1 auto;min-width:0;height:26px;padding:0 8px;border-radius:7px;',
            'border:1px solid rgba(128,128,128,0.35);background:rgba(255,255,255,0.9);color:inherit;',
            'font:inherit;font-size:12.5px;outline:none;}',
            '.handoff-card-input:focus{border-color:rgba(0,122,255,0.7);}',
            '@media (prefers-color-scheme:dark){.handoff-card-input{background:rgba(255,255,255,0.06);}}',
            '.handoff-card-send{height:26px;padding:0 10px;font-size:12px;opacity:0.9;}',
            '.handoff-card-send:disabled{opacity:0.35;cursor:default;}'
          ].join('')
          document.head.appendChild(style)
          return () => style.remove()
        }, 'handoff activity styles')

        // Sit above the composer, in the same overlay slot the BTW plugins use.
        try {
          ctx.inject(['slots'], (scope) => {
            scope.effect(() => scope.slots.register({
              name: 'conversation.input.overlay',
              id: 'handoff:activity',
              order: 12
            }, ActivityCard))
          })
        } catch {
          // No slots service: the command cards still report everything.
        }

        // A command submitted through the composer names its session; the host
        // has already written the slot by the time this fires.
        try {
          ctx.on('command/executed', (sessionId, name) => {
            if (!COMMANDS.has(name) || !sessionId) return
            try { localStorage.setItem(STORAGE_KEY, sessionId) } catch { /* private mode */ }
            store.set({ sessionId, open: true, activity: store.state.sessionId === sessionId ? store.state.activity : null })
            poll(sessionId)
          })
        } catch {
          // Older shells without the event: the card simply stays closed.
        }

        // A reload during a running request should still find the card.
        try {
          const last = localStorage.getItem(STORAGE_KEY)
          if (last) {
            store.set({ sessionId: last })
            fetch(`/handoff/activity?session=${encodeURIComponent(last)}`, { cache: 'no-store' })
              .then((response) => (response.ok ? response.json() : undefined))
              .then((activity) => {
                if (!activity || activity.status !== 'running') return
                store.set({ activity, open: true })
                poll(last)
              })
              .catch(() => {})
          }
        } catch {
          // No storage access: nothing to resume.
        }
      }
    }
  }
})
