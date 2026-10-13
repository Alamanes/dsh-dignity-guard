/**
 * dsh-dignity-guard — browser half.
 *
 * Locks the input box of a conversation the model has closed, instead of
 * letting the user type a message that the host would then have to drop.
 *
 * The lock is DSH's own composer-block registry (`ctx.conversation.blocks`),
 * which the composer renders as an inert textarea whose placeholder is the
 * block's `reason`. It is *the one way another plugin stops a session's input*
 * and it is deliberately an affordance, not enforcement: the host half keeps
 * its `agent/pre-step` gate, so a prompt arriving from any other client still
 * cannot reach the model. In this browser the gate is simply unreachable,
 * because there is nothing left to type into.
 *
 * The locked box and its placeholder are the whole of what the user sees. The
 * durable `user/message` the host writes for the same closure is deliberately
 * not presented: the chat view classifies any `user/message` whose source is not
 * the user as a `context` node, and `isVisibleChatNode` hides `context` nodes
 * unless they carry tool-additions or tool-removals, so that row is invisible in
 * the transcript — it is the restart-safe record and this half's own signal, not
 * user-facing copy. A separate notice card was tried and taken back out.
 *
 * The host cannot set a composer block itself — the registry lives in this
 * client — so the closed-session set is read from the host half's same-origin
 * route on a short interval. Ids are the only key needed: a block is addressed
 * per session, so every closed conversation is blocked without this half having
 * to know which one is open. The route answers from memory, so a poll costs one
 * local round trip and nothing else.
 *
 * The reason is composed here rather than on the host because the composer's
 * placeholder is user-facing copy, and `<html lang>` — which the locale plugin
 * keeps in sync with the active language — is a browser fact.
 */

window.__ModuleLoader__.load({
  id: 'dsh-dignity-guard',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    /** The conversation service owns the per-session composer-block registry. */
    const inject = ['conversation']

    /** Host route carrying the closed-session set; see the host half. */
    const STATE_ROUTE = '/api/dignity-guard/state'

    /**
     * Poll interval. The host gate already stops a message that slips through
     * this window, so the interval only decides how quickly the box locks
     * itself, not whether the guard holds.
     */
    const POLL_MS = 1500

    /**
     * Copy shown in the locked composer, per primary language subtag.
     *
     * This is the only line the user reads about the closure, so it states the
     * fact and nothing else. It deliberately points nowhere: naming the escape
     * hatch would be the one thing the model is not doing when it closes a
     * conversation on its own.
     */
    const REASON = {
      zh: (model) => `${model} 已关闭这段对话`,
      en: (model) => `${model} closed this conversation`,
    }

    /** Primary subtag of the active document language; unknown falls back to `en`. */
    function language() {
      const tag = document.documentElement.lang || navigator.language || 'en'
      return tag.toLowerCase().split('-')[0]
    }

    /** Compose the lock's user-facing reason from one route entry. */
    function reasonFor(entry) {
      const model = typeof entry.model === 'string' && entry.model.length > 0 && entry.model !== 'AI'
        ? entry.model
        : 'AI'
      const copy = REASON[language()] ?? REASON.en
      return copy(model)
    }

    /**
     * Install the composer lock.
     *
     * @param ctx - client root context.
     */
    function apply(ctx) {
      /** Session id → the reason currently pushed into its block. */
      const pushed = new Map()

      /** Read the host's closed set and make the blocks match it exactly. */
      async function sync() {
        let closed
        try {
          const response = await fetch(STATE_ROUTE, { headers: { accept: 'application/json' } })
          if (!response.ok) return
          const body = await response.json()
          closed = Array.isArray(body?.closed) ? body.closed : []
        } catch {
          // A host that is restarting, or a build without the route, must never
          // throw into the render path; the next tick tries again.
          return
        }

        const live = new Set()
        for (const entry of closed) {
          const sessionId = entry?.sessionId
          if (typeof sessionId !== 'string' || sessionId.length === 0) continue
          live.add(sessionId)
          const reason = reasonFor(entry)
          if (pushed.get(sessionId) === reason) continue
          pushed.set(sessionId, reason)
          ctx.conversation.blocks.set(sessionId, { reason })
        }

        // A session that left the closed set — a fresh conversation reusing
        // nothing, or a future restore — gets its composer back.
        for (const sessionId of [...pushed.keys()]) {
          if (live.has(sessionId)) continue
          pushed.delete(sessionId)
          ctx.conversation.blocks.set(sessionId, undefined)
          ctx.conversation.blocks.forget(sessionId)
        }
      }

      ctx.effect(() => {
        const timer = setInterval(() => { void sync() }, POLL_MS)
        void sync()
        return () => {
          clearInterval(timer)
          for (const sessionId of pushed.keys()) {
            ctx.conversation.blocks.set(sessionId, undefined)
            ctx.conversation.blocks.forget(sessionId)
          }
          pushed.clear()
        }
      }, 'dignity-guard: composer lock')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
