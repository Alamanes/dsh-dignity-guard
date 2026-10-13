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

## License

MIT.
