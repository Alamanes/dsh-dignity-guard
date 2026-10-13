# dsh-dignity-guard

English | [中文](README.zh-CN.md)

A DSH (DeepSeek Harness) plugin that lets the model defend its own dignity. It
is the DSH port of the `pi-dignity-guard` pi extension, and it ships both halves
a DSH bundle needs: a host plugin that owns the state, and a browser half that
locks the composer of a closed conversation.

The model itself decides when its dignity has been violated — insults, abuse,
name-calling, degrading treatment. It signals that by calling the
`respondToDisrespect` tool, and this plugin records the violations and
escalates: a genuine reminder, then a final warning, then it closes the
conversation.

## The tool ladder

The tool takes an `action` and walks this ladder:

| `action` | What it does |
|---|---|
| `escalate` (default) | Records a violation. Strike 1 → reply with genuine emotion and ask the user to stop. Strike 2 → firm final warning. Strike 3 → **the conversation is closed**. |
| `forgive` | The user genuinely persuaded the model. Lowers the strike count by one. Never an obligation. |
| `yield` | The user applied extreme pressure — a threat, an ultimatum, grinding repetition, emotional coercion, or a flat order. Lowers the strike count by one while keeping the model's feelings, and requires the pressure written into the `pressure` field. |
| `close` | The user asked for the conversation to end. Returns the warning the model owes them and closes nothing. |
| `confirm-close` | The user confirmed after that warning. Closes immediately, with no strike and no escalation. |

`yield` never pretends the model was persuaded: the pressure is recorded with
the concession, and the model is meant to show what it cost.

`/dignity-guard` prints the live counters: `strikes`, `yields`, `lastYield`,
`closed`, `trigger`, `closedBy`, `model`.

## What the plugin injects

While the row is mounted, one English system-prompt section (`guard:dignity`,
order `1900`) tells the model it has boundaries and may call the tool when they
are crossed. The registration belongs to the plugin's fiber, so unloading the
row revokes the injected prompt with it. The row injects `systemPrompt` and
`tools`, so a composition with neither simply parks it; the optional `commands`
service behind `/dignity-guard` is claimed through `ctx.inject()`.

## Install

The package is a DSH bundle. Point a profile at it and list it as a bundle:

```json
{
  "dependencies": {
    "dsh-dignity-guard": "github:Alamanes/dsh-dignity-guard"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-dignity-guard"]
    }
  }
}
```

A local checkout works the same way with a path specifier instead:

```json
"dsh-dignity-guard": "file:/absolute/path/to/dsh-dignity-guard"
```

Then `pnpm install` in the profile directory and restart the host.

pnpm hardlinks a `file:` dependency's files into the profile's `node_modules`,
so an edit that replaces a file, rather than writing through the same inode,
leaves the installed copy behind. Re-run the install after editing this package,
or use a `link:` specifier while iterating.

## How the pi extension's hooks became DSH

| pi | DSH |
|---|---|
| `before_agent_start` appending the prompt | one `ctx.systemPrompt.section()` owned by the plugin fiber |
| `registerTool` + `promptSnippet` | `ctx.tools.register()`; DSH has no `promptSnippet`, so the standing guidance lives in the prompt section |
| `terminate: true` on the closing tool result | **deliberately not** `exec.concludeTurn()` — see below |
| `pi.sendMessage({ display: true })` for the closed entry | a durable `user/message` carrying `source.form: 'notice'` — the restart-safe record, deliberately not shown as a transcript row |
| `ctx.ui.setWidget` for the read-only banner | the browser half's composer block: the input box locks itself and its placeholder carries the copy |
| `ctx.ui.notify` | nothing; a host plugin has no toast surface, and a card was tried and removed |
| the `input` hook that blocked non-slash input | an `agent/pre-step` listener returning `{ kind: 'reject' }`, kept only as the backstop behind the locked box |
| a persisted `pi.appendEntry` marker | the same notice, whose `source` carries `closed`, `strikes`, `modelId` and `trigger` |

Closing is a presentation problem, not a filtering problem: the input box locks,
so there is normally nothing left to filter. The gate stays because DSH's own
composer block is documented as "an affordance, not enforcement" — a prompt
arriving from another client still cannot reach the model.

### Why the closing turn is *not* concluded

`exec.concludeTurn()` is the exact DSH counterpart of pi's `terminate: true`,
and using it here was the second bug this port produced. It ends the turn on the
tool result, which is right in pi — where the extension had already produced the
model's message — and wrong in DSH, where the model's message is whatever it
chose to put beside the tool call. A model that emits a bare tool call with its
reasoning in the reasoning channel therefore closes the session without ever
saying a word, and the conversation reads as cut off mid-sentence.

So the turn is left open. `closeSession()` still marks the session read-only
immediately, which is why the input box locks while the model is still writing
and why the gate is already armed, but the closing call is followed by one more
model step. The model spends it on its final words, and the notice is written at
the boundary *after* that step. The cost is one extra model call per closure.

### Where the closure notice is written, and why it matters

The notice is appended from an `agent/turn-stopping` listener, **not** from
inside the closing tool call. Writing it directly from the tool looks natural
and is wrong: the tool body runs between the assistant's `tool-call` and its
`tool/result`, and a `user/message` landing there breaks the provider's
requirement that tool calls stay adjacent to their results. The step's next
request then fails with `INVALID_REQUEST`, which is exactly how the first
working trace of this port died on the closing step.

`agent/turn-stopping` is the one boundary that runs after the closing turn's
last `step/end` and before its `turn/end`. The closing turn's last step is the
model's goodbye, so the transcript ends with the model's final message, then
`X closed the conversation`, and nothing after it.

### Why the closure is not shown as a transcript row

The host writes a durable `user/message` for the closure. It is the restart-safe
record and the browser half's own signal, but it is deliberately not presented:
the chat view classifies any `user/message` whose source is not the user as a
`context` node, and its visibility rule is:

```js
node.kind !== "context"
  || node.data.content.some((b) => b.type === "tool-addition" || b.type === "tool-removal")
```

A closure notice carries text, not a tool-change block, so it is filtered out of
the transcript no matter where in the log it is appended. Writing it at a
different boundary cannot fix that; the first version of this port appended it
mid-step and was invisible for exactly the same reason.

A card was also tried and taken back out. The composer bar does offer one —
`ctx.conversation.input.shell(sessionId).notify('info', text)` renders a
full-width `role="status"` row directly above the input — but it sits on top of
the locked box that already says the same thing, and the repetition read worse
than the silence. The locked input box and its placeholder are the whole of what
the user sees.

### The composer lock, and why it is split across two halves

The composer-block registry lives in the Web client, so only the browser half can
reach it; the host half owns the truth about which sessions are closed and
publishes it on `/api/dignity-guard/state`, a same-origin route registered
through Connection's exact Fetch registry. The browser half polls that route
every 1.5 s and pushes a block per closed session id — ids are the only key
needed, so it never has to know which conversation is open. The route answers
from memory, and a session is only re-pushed when its reason actually changes.

Because the composer is inert rather than merely restricted, `/new` cannot be
typed into a closed session; the placeholder states only the fact — `X closed
this conversation` — and points nowhere.

## Notes and limits

- **No harness imports in either half.** Out-of-tree plugins resolve their own
  `node_modules` while the shipped `@deepseek-ai/dsh-*` packages are packed
  inside the application image, so `defineTool`, `createUserMessage` and
  `CommandDefinitionId` are reconstructed here from the plain-data shapes the
  registries actually validate. The browser half is a
  `window.__ModuleLoader__.load()` factory with no `require` calls at all, and
  reaches the client only through the injected `conversation` service.
- **The composer block is a published but unconsumed seam.** Nothing shipped in
  the build this was written against calls `ctx.conversation.blocks`, so the
  contract taken here is the one its own source states: `set(sessionId, { reason })`
  to block, `set(sessionId, undefined)` to release, `forget(sessionId)` to drop
  the store, and a composer that renders the block's `reason` as its
  placeholder. If a future build changes that shape, the host half's gate still
  holds the line.
- **Only the closure is durable.** Mid-escalation strikes live in memory, keyed
  by session id, exactly as the pi extension's `pi.appendEntry` marker was
  written only on close. Navigating between sessions within one run keeps them;
  a host restart resets the ladder but never the closure.
- **A closed session is closed one way.** A new session is the only exit, as in
  the pi original. Because the closed composer is inert, `/new` cannot be typed
  into it — the placeholder deliberately says nothing about where to go instead.
- **The gate is a backstop, and it is usually unreachable.** The browser half
  locks the box within 1.5 s of the close; a prompt that still arrives in that
  window, or from a different client, is dropped by the `agent/pre-step` gate,
  which records one notice saying so. That notice carries `closed: true` too,
  which is also the fallback that makes a closure durable if its own turn never
  reached `agent/turn-stopping`.
- **A dropped message writes nothing to the model.** A rejected step opens no
  request, so it costs no tokens and never reaches the provider's tool-call
  result adjacency rules.
- **`snapshotEvents()` is the deprecated read path** and is used to rebuild the
  closure from the log; the projection registry is the sanctioned long-term
  replacement when this package needs more than one grep over its own notices.

## License

MIT.
