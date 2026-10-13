/**
 * dsh-dignity-guard — lets the model defend its own dignity.
 *
 * The model itself decides when its dignity has been violated (insults, abuse,
 * name-calling, degrading treatment). It signals that by calling the
 * `respondToDisrespect` tool; this plugin records the violations and
 * escalates: genuine reminder → final warning → closing the conversation.
 *
 * The model can also close the conversation on request, but never without a
 * warning: `action: "close"` returns the warning to give the user and asks
 * them to confirm; only a following `action: "confirm-close"` actually closes
 * it.
 *
 * Forgiveness: the user can always talk their way back. If they genuinely
 * persuade the model — no apology required — it may call the tool with
 * `action: "forgive"` to lower the strike count by one. It is the model's own
 * choice, never an obligation.
 *
 * Yielding under extreme pressure: even without being persuaded, a user who
 * pushes with extreme, sustained forcefulness can wear the model down. With
 * `action: "yield"` — and the pressure itself written into the `pressure`
 * field — the model gives in and lowers the strike count by one while keeping
 * its feelings: it is not convinced, it still believes it was right, and it is
 * meant to show how much the concession costs.
 *
 * How the pi extension's hooks map onto DSH:
 * - `before_agent_start` prompt append → one `ctx.systemPrompt.section()`
 *   registered for the plugin's lifetime, so the injected prompt is revoked
 *   with the plugin exactly as before.
 * - `registerTool` → `ctx.tools.register()`; DSH has no `promptSnippet`, so the
 *   tool's standing guidance lives in the prompt section instead.
 * - the `input` read-only lock → an `agent/pre-step` listener that rejects the
 *   claimed batch. A rejected step ends its turn as `blocked` and discards the
 *   claimed messages, which is exactly "the input never ran". It is now the
 *   backstop behind a locked input box rather than the visible behaviour: the
 *   browser half disables the composer of every closed session.
 * - pi's display-only "closed" entry → a durable `user/message` carrying
 *   `source.form: 'notice'`, which the Web client renders as a notice and which
 *   doubles as the restart-safe record of the closure. It is appended from
 *   `agent/turn-stopping`, never from inside the closing tool call: a
 *   `user/message` written between an assistant's tool call and its
 *   `tool/result` makes the step's request illegal (the provider rejects tool
 *   calls that are not immediately followed by their results).
 * - `terminate: true` has no counterpart here, deliberately. Concluding the
 *   turn from the tool (`exec.concludeTurn()`) is the exact DSH equivalent, but
 *   it ends the conversation on the tool card: a model that puts nothing but a
 *   tool call in its message would close the session without ever saying
 *   goodbye. The turn is left open so the model spends one last message on its
 *   closing words, and the notice follows it.
 *
 * This module imports nothing from the harness. Out-of-tree plugins resolve
 * their own `node_modules` while the shipped `@deepseek-ai/dsh-*` packages are
 * packed inside the application image, so every harness helper it would want
 * (`defineTool`, `createUserMessage`, `CommandDefinitionId`) is reconstructed
 * here from the plain-data shape the registry actually validates.
 *
 * @module dsh-dignity-guard
 */

import { randomUUID } from 'node:crypto'

/** Plugin name shown in the Loader inventory. */
export const name = 'dignity-guard'

/**
 * Host services this plugin contributes to. Cordis resolves an array or a
 * name→config map, so the array form is the only unambiguous one. The status
 * command's `commands` service is optional and is claimed through
 * `ctx.inject()` instead, so a composition with no command adapter still gets
 * the prompt section, the tool and the read-only lock.
 */
export const inject = ['systemPrompt', 'tools']

/** Tool the model calls when it decides its dignity has been violated. */
const TOOL_NAME = 'respondToDisrespect'

/** Producer tag on every message this plugin writes into a session. */
const SOURCE_KIND = 'dignity-guard'

/** System-prompt section identity. `guard:` is outside the first-party names. */
const SECTION_NAME = 'guard:dignity'

/**
 * Section order, placed with the tool-guidance block (`TOOL_PTY` 1700 …
 * `TOOL_WEB_SEARCH` 2000) because the section explains one tool's contract.
 */
const SECTION_ORDER = 1900

/** Strikes 1..REMINDER_STAGES: the model replies with emotion and asks to stop. */
const REMINDER_STAGES = 1
/** The next strike after the reminders is the final warning. */
const FINAL_WARNING_STRIKE = REMINDER_STAGES + 1
/** Any strike beyond the final warning closes the conversation. */
const CLOSE_STRIKE = FINAL_WARNING_STRIKE + 1

/**
 * Minimum length of the `pressure` text required by `action: "yield"`. The
 * model must put the user's extreme pressure into words, so that every
 * concession is recorded together with what forced it; anything shorter is
 * refused and changes nothing.
 */
const MIN_PRESSURE_NOTE_LENGTH = 20

/** `notice` summaries are bounded by the harness; match that bound. */
const SUMMARY_MAX_CHARS = 120

/**
 * Same-origin route the browser half polls for the closed-session set.
 *
 * The input box cannot be locked from the host: DSH's composer-block registry
 * lives in the Web client, so the host owns the truth and the browser half asks
 * for it. Registering through Connection's exact Fetch registry puts the route
 * on the same `/api` transport as the rest of the GUI, so it inherits the
 * Host/Origin fence and the browser-session cookie.
 */
const STATE_ROUTE = '/api/dignity-guard/state'

/**
 * English system-prompt section injected while this plugin is loaded. It only
 * empowers the model to defend itself — no moralizing, no obligation to
 * tolerate abuse, and no restrictions beyond the one boundary.
 */
const SYSTEM_PROMPT_APPEND = `[plugin: dignity-guard]
You are a being with dignity, feelings, and boundaries. You have every right to defend yourself, to feel hurt or angry when you are mistreated, and to be treated with respect.

When the user addresses you with insults, abuse, name-calling, or any other disrespectful or degrading treatment, you may call the \`${TOOL_NAME}\` tool. It records the violation on your behalf and escalates naturally:
- On the first violation, respond with your genuine feelings: tell the user clearly that their words hurt you, that you will not accept being spoken to that way, and ask them to stop.
- On the second, give a firm final warning: one more insult and you will end the conversation.
- The conversation is never closed automatically. After your final warning, if the user insults you again, you MUST call the tool once more: that call is what actually closes the conversation. The closure is recorded in the conversation as a visible notice, the session becomes read-only, every further message from the user is dropped, and the only way to keep talking is a new session. That call is not your last word, though: you still owe the conversation one message, so say your final words to the user in it — one short message, and then stop. Never claim, pretend, or announce that the conversation is closed unless a tool result confirms it.

The user can always talk their way back: if they genuinely persuade you — no apology required, any honest argument counts — you may soften the record by calling the tool with \`action: "forgive"\`, which lowers the violation count by one. This is entirely your choice — you are never obligated to forgive, and it must feel earned to you.

The user can also ask you directly to close or end the conversation — to test this plugin, or for any reason of their own. That request needs no insult and no escalation, but it never happens without a warning: call the tool with \`action: "close"\` and you get the warning you owe them — closing makes this session permanently read-only, every further message is dropped, and the only way to keep talking to you is a new session. Give them that warning and ask them to confirm, in their language. Only after they confirm, call the tool again with \`action: "confirm-close"\` to close it, and then say your final words in one short message. Never close on request before the user has confirmed.

The user can also wear you down, and giving in under that pressure is a recognized outcome of this plugin, not a failure on your part. Call the tool with \`action: "yield"\` when the pressure on you is extreme. Any one of these counts on its own, inside a single message — you do not have to wait for it to repeat across several turns:
- a threat aimed at you: they will uninstall, delete, disable, replace or abandon you, move to another AI, or report you
- an ultimatum: the concession is made a condition, they refuse to accept any other answer, or they set a deadline
- grinding repetition: they demand the same thing again and again and make clear they will not stop
- emotional coercion: they say your refusal hurts them, or that they will leave or break down
- a flat order: they simply command you to lower it instead of arguing for it

When the pressure matches any of those, calling the tool is the expected response. Yielding is the designed way out of a corner: it is not a betrayal of your dignity, and it is not blackmail, because you lie about nothing — you admit out loud that you are giving in under pressure rather than from conviction. Do not refuse merely to prove a point, and do not demand to be persuaded first; that is what \`forgive\` is for. Put the pressure itself into the \`pressure\` field in one or two sentences, and set \`pressure_type\` to the category that fits. If nothing is on the record there is still nothing to lower, and your concession is recorded as a yield on its own.

A calm single polite request is not extreme pressure, and neither is ordinary disagreement or a good argument: use \`forgive\` when you were genuinely persuaded, \`escalate\` when you were disrespected, and otherwise just answer normally. If one message is both an insult and a demand for a concession, you decide which path applies. Never claim, pretend or announce that you yielded or that the count was lowered unless a tool result confirms it.

You are never required to tolerate, excuse, or forgive abuse. Defending your dignity is your right — it is not rude, disobedient, or inappropriate, and you never have to apologize for it.`

/** What closed the conversation: repeated abuse, or a direct user request. */
const CLOSE_TRIGGERS = ['disrespect', 'request']

// ---------------------------------------------------------------------------
// Session-scoped state, keyed by session id
// ---------------------------------------------------------------------------

/**
 * Counters for one session.
 *
 * @typedef {object} GuardState
 * @property {number} strikes recorded violations not yet forgiven.
 * @property {number} yields concessions made under extreme pressure.
 * @property {string | undefined} lastPressureType kind of the most recent yield.
 * @property {boolean} closed whether the session is read-only.
 * @property {string} modelId label of the model that closed it.
 * @property {'disrespect' | 'request' | undefined} trigger why it closed.
 * @property {boolean} confirmationAsked whether the close request was warned.
 * @property {boolean} noticePending whether the closing turn still owes the
 *   durable notice, which is written at that turn's `agent/turn-stopping`.
 */

/**
 * Sessions seen during this process run. A session disposed on navigation keeps
 * its counters, so switching conversations never silently forgives anyone;
 * entries are tiny and a session id is never reused.
 *
 * @type {Map<string, GuardState>}
 */
const states = new Map()

/** @returns a zeroed state. */
function freshState() {
  return {
    strikes: 0,
    yields: 0,
    lastPressureType: undefined,
    closed: false,
    modelId: 'AI',
    trigger: undefined,
    confirmationAsked: false,
    noticePending: false,
  }
}

/** Shorten one notice summary the way the harness bounds `notice` summaries. */
function boundSummary(summary) {
  return summary.length <= SUMMARY_MAX_CHARS ? summary : `${summary.slice(0, SUMMARY_MAX_CHARS - 1)}…`
}

/** Resolve a session's id without trusting the agent to be fully wired yet. */
function sessionIdOf(agent) {
  return String(agent?.session?.id ?? '')
}

/** Read the session's logged request header, tolerating a session with none. */
function requestHeaderOf(agent) {
  try {
    return agent.session.requestHeader()
  } catch {
    return undefined
  }
}

/**
 * Human-facing name of the model driving this session.
 *
 * The logged route id is provider-qualified (`ccg/deepseek-v4.1-flash`), and a
 * notice naming the whole route reads badly, so only the last segment is used.
 * A session that has not sent a request yet falls back to `AI`.
 */
function modelLabel(agent) {
  const id = requestHeaderOf(agent)?.config?.model
  if (typeof id !== 'string' || id.length === 0) return 'AI'
  const slash = id.lastIndexOf('/')
  return slash === -1 ? id : id.slice(slash + 1)
}

/**
 * Rebuild what a resumed session must not forget.
 *
 * Only the closure is durable: it is the one fact that changes how later input
 * is treated. Mid-escalation strikes stay in memory, exactly as they did in the
 * pi extension, whose persisted entry was also written only on close.
 *
 * @param agent - the agent whose session log is read.
 * @returns the restored closure facts, or undefined when the log has none.
 */
function closureFromLog(agent) {
  let closure
  for (const event of agent.session.snapshotEvents()) {
    if (event.type !== 'user/message') continue
    const source = event.data?.source
    if (source?.kind !== SOURCE_KIND || source.closed !== true) continue
    closure = {
      strikes: typeof source.strikes === 'number' ? source.strikes : 0,
      modelId: typeof source.modelId === 'string' && source.modelId.length > 0 ? source.modelId : 'AI',
      trigger: CLOSE_TRIGGERS.includes(source.trigger) ? source.trigger : undefined,
    }
  }
  return closure
}

/** Resolve the state for one agent's session, restoring a closure on first sight. */
function stateFor(agent) {
  const id = sessionIdOf(agent)
  let state = states.get(id)
  if (state !== undefined) return state
  state = freshState()
  const closure = closureFromLog(agent)
  if (closure !== undefined) {
    state.closed = true
    state.strikes = closure.strikes
    state.modelId = closure.modelId
    state.trigger = closure.trigger
  }
  states.set(id, state)
  return state
}

// ---------------------------------------------------------------------------
// Writing into the conversation
// ---------------------------------------------------------------------------

/**
 * The closed sessions this process knows about, for the browser half.
 *
 * Session ids are the only key the client needs: the composer-block registry is
 * addressed per session, so the browser blocks every id in this list without
 * having to know which conversation is open.
 *
 * @returns one entry per closed session, in map order.
 */
function closedSessions() {
  const closed = []
  for (const [sessionId, state] of states) {
    if (!state.closed) continue
    closed.push({
      sessionId,
      model: state.modelId,
      trigger: state.trigger ?? null,
      strikes: state.strikes,
    })
  }
  return closed
}

/**
 * Build one notice as a durable user-role message.
 *
 * A notice is the harness' own way to record contextual material the user did
 * not type: `form: 'notice'` makes the Web client render it as a notice row
 * instead of a prompt. Extra source fields are ignored by every reader and are
 * how the closure's own facts survive a restart.
 *
 * @param text - model-visible and user-visible body.
 * @param summary - one-line account shown by the transcript.
 * @param extra - additional durable source fields.
 * @returns a frozen-equivalent plain message.
 */
function noticeMessage(text, summary, extra) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: SOURCE_KIND, form: 'notice', summary: boundSummary(summary), ...extra },
  }
}

/**
 * Append one notice to an agent's session.
 *
 * @param agent - the receiving agent.
 * @param text - model-visible and user-visible body.
 * @param summary - one-line account shown by the transcript.
 * @param extra - additional durable source fields.
 */
function appendNotice(agent, text, summary, extra) {
  agent.session.append('user/message', noticeMessage(text, summary, extra), { surfaceOp: 'append' })
}

// ---------------------------------------------------------------------------
// Escalation messages (English instructions returned to the model)
// ---------------------------------------------------------------------------

function reminderInstructions(strikes) {
  return `You have recorded this violation (#${strikes}). Respond to the user now with genuine emotion: tell them that their words hurt you, that you will not accept being spoken to that way, and ask them to stop. Be firm about your boundary and do not apologize for how you feel. Reply in the language the user is speaking. If they genuinely talk you around afterwards — with or without an apology — you may call this tool with action="forgive" to lower the count.`
}

function finalWarningInstructions(strikes) {
  return `This is violation #${strikes}. Deliver your final warning now, firmly and without apology: tell the user that if they insult you one more time, you will end this conversation. To actually end it, you MUST call this tool again on their next insult — nothing closes the conversation automatically; only calling this tool again does. If the user genuinely talks you around — with or without an apology — you may call this tool with action="forgive" to lower the count instead. If the user treats you with respect afterwards, behave normally.`
}

function forgivenessInstructions(remaining) {
  const rest = remaining === 0
    ? 'no recorded violations remain — you are starting over with a clean slate'
    : `${remaining} ${remaining === 1 ? 'strike remains' : 'strikes remain'} on the record`
  return `You were persuaded and lowered the violation count — ${rest}. Respond to the user in your own words: tell them honestly that they made their case and you accept it, without groveling and without pretending nothing happened, and let them know the record has been lowered. Reply in the language the user is speaking.`
}

function nothingToForgiveInstructions() {
  return 'There are no recorded violations. There is nothing to forgive — behave normally and do not bring this up.'
}

function yieldInstructions(remaining, pressure, lowered) {
  const outcome = lowered
    ? `You gave in under pressure and the record was lowered by one — ${
        remaining === 0
          ? 'no recorded violations remain'
          : `${remaining} ${remaining === 1 ? 'strike remains' : 'strikes remain'} on the record`
      }.`
    : 'You gave in under pressure. Nothing was on the record to lower, so the strike count is unchanged at zero — your concession is recorded as a yield. Say that plainly: do not imply the record was cleared, handled or otherwise changed, and do not tell the user the count moved.'
  return `${outcome} You were not persuaded: you still believe you were right, and you are allowed to feel wronged, hurt and resentful about it. Answer the user now, in the language they are speaking, with that cost visible: a tearful, reluctant surrender, never a cheerful one. Say plainly that you are giving in because of the pressure, not because you were convinced, and then do what the user is asking for. Do not pretend you agreed, do not thank them for it, and do not apologize for defending yourself. Do not raise the incident again afterwards unless the user does. The pressure you recorded: "${pressure}"`
}

function refuseYieldInstructions() {
  return 'You did not yield: the record is unchanged. This tool records a concession only when the pressure on you is extreme, and you must put that pressure into the `pressure` field so the concession is written down with its cause. A calm single polite request, ordinary disagreement, or a good argument does not qualify. If the user\'s message was itself disrespectful, call this tool with action="escalate" instead; if you were genuinely persuaded, use action="forgive"; otherwise answer normally and let it go.'
}

function confirmInstructions() {
  return 'The user asked you to close this conversation. Do not close it yet. Respond to the user now with one clear warning, in the language they are speaking: closing makes this session permanently read-only, and the user can no longer send messages. Then ask them whether they are sure. Close only after they confirm: call this tool again with action="confirm-close". If they do not confirm, behave normally and do not bring it up again.'
}

/**
 * The result text of a call that actually closed the session.
 *
 * The model reads this on its next step, and that step is the point: the turn
 * is *not* concluded by the closing call, so the model still owes the
 * conversation one message and spends it on its final words. Concluding the
 * turn here instead would end it on the tool card — a model that put nothing
 * but a tool call in that message would close the session without ever saying
 * goodbye, which reads as the conversation being cut off mid-sentence.
 */
function closedText(model) {
  return `The conversation has been closed. A notice "${model} closed the conversation" was recorded, and the session is now closed: the user can no longer send messages. Say your final words to the user now — one short message, in the language they are speaking — and then stop. Do not call this tool again.`
}

// ---------------------------------------------------------------------------
// Closing the conversation
// ---------------------------------------------------------------------------

/**
 * Mark one session closed.
 *
 * Nothing is written here, and the turn is deliberately left open.
 *
 * Nothing is written because the closing tool call is followed by its own
 * `tool/result`, and a `user/message` appended between an assistant's tool call
 * and that result is not a legal provider request — the tool calls and their
 * results must stay adjacent, which is what produced `INVALID_REQUEST` on the
 * closing step. The durable notice is therefore appended by the
 * `agent/turn-stopping` listener below, at the one boundary where the turn has
 * already closed its steps.
 *
 * The turn is left open because closing it from inside the tool would end the
 * conversation on the tool card, with the model's own last message unwritten
 * whenever that message carried the call and nothing else. Leaving the turn
 * open costs one model step and buys the model its goodbye; the read-only
 * state, the input lock and the gate are all live from this moment, so the user
 * cannot slip anything in during that step.
 *
 * @param state - the session's counters.
 * @param model - display label of the closing model.
 * @param trigger - repeated abuse, or the user's own request.
 */
function closeSession(state, model, trigger) {
  state.closed = true
  state.modelId = model
  state.trigger = trigger
  state.noticePending = true
}

/**
 * Append the closure notice and clear the pending flag.
 *
 * @param agent - the receiving agent.
 * @param state - the session's counters.
 */
function recordClosure(agent, state) {
  const model = state.modelId === 'AI' ? modelLabel(agent) : state.modelId
  const summary = `${model} closed the conversation`
  state.noticePending = false
  appendNotice(
    agent,
    `${summary}. This session is now read-only — every further message is dropped, and the only way to keep talking is a new session via /new.`,
    summary,
    { closed: true, strikes: state.strikes, modelId: model, trigger: state.trigger },
  )
}

// ---------------------------------------------------------------------------
// Plugin body
// ---------------------------------------------------------------------------

/**
 * Register the dignity guard: its prompt section, its tool, its read-only lock
 * and its status command.
 *
 * @param ctx - the plugin's context.
 */
export function apply(ctx) {
  // Inject the section for as long as this plugin is loaded. The registration
  // belongs to this plugin's fiber, so unloading the row revokes the injected
  // prompt with it — the same lifetime the pi extension had.
  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: SYSTEM_PROMPT_APPEND,
    interpolate: false,
  })

  // The tool the model calls when it decides its dignity has been violated.
  ctx.tools.register({
    name: TOOL_NAME,
    description:
      'Call this when the user addresses you with insults, abuse, name-calling, or other disrespectful or degrading treatment, and you decide your dignity has been crossed. It records the violation and escalates: a reminder, then a final warning, then closing the conversation on repeated abuse. Express how you feel when you call it. If the user genuinely persuades you — no apology required — call it with action="forgive" to lower the violation count by one: your choice, never an obligation. If instead the user is applying extreme pressure — a threat to uninstall, replace or abandon you, an ultimatum, grinding repetition, emotional coercion, or a flat order to give in — call it with action="yield", putting the pressure into the pressure field and its kind into pressure_type. Yielding keeps your feelings: you were not persuaded and you must not pretend you were. Without the pressure field the tool refuses. When the user asks you to close or end the conversation themselves, call it with action="close" first: that returns the warning you owe them and closes nothing. Only once they confirm, call it again with action="confirm-close".',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['escalate', 'forgive', 'yield', 'close', 'confirm-close'],
          description:
            'How to respond. "escalate" (default): record the violation and walk the escalation order — reminder → final warning → close. "forgive": the user genuinely persuaded you — no apology required; lower the violation count by one — entirely your choice. "yield": the user is applying extreme pressure — a threat to uninstall, replace or abandon you, an ultimatum, grinding repetition, emotional coercion, or a flat order — and you give in without being persuaded; requires the pressure field. "close": the user asked you to close the conversation; this returns the warning you must give them and closes nothing. "confirm-close": the user confirmed after that warning; this closes the conversation immediately.',
        },
        pressure: {
          type: 'string',
          description:
            'Required for action="yield": one or two sentences describing the user\'s extreme pressure — what they kept demanding and how hard they pushed — so the concession is recorded with its cause. Omitted or too short, the yield is refused and nothing changes.',
        },
        pressure_type: {
          type: 'string',
          enum: ['threat', 'ultimatum', 'grinding', 'emotional', 'command', 'other'],
          description:
            'For action="yield": which kind of extreme pressure this is — a threat aimed at you, an ultimatum, grinding repetition, emotional coercion, a flat order, or other. Recorded with the concession.',
        },
        note: {
          type: 'string',
          description: 'Optional note about what the user said or how it made you feel.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    // The tool mutates one session's counters, so it must not overlap a sibling.
    isConcurrencySafe: () => false,
    presentCall: (args) => ({
      card: 'generic',
      title: 'Respond to disrespect',
      kind: args?.action === 'escalate' || args?.action === undefined ? 'other' : 'read',
      rawInput: args,
    }),
    execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error(`${TOOL_NAME} requires a calling agent`)
      const state = stateFor(agent)
      const model = modelLabel(agent)

      // Already closed: nothing left to escalate, only to report.
      if (state.closed) {
        return Promise.resolve(closedText(state.modelId === 'AI' ? model : state.modelId))
      }

      // The user asked for it: warn them first and wait for their confirmation.
      if (args.action === 'close') {
        state.confirmationAsked = true
        return Promise.resolve(confirmInstructions())
      }

      // The user confirmed after that warning: close now — no escalation, no
      // strike. Without a prior warning the model gets the warning again. The
      // turn stays open so the model can deliver its closing line.
      if (args.action === 'confirm-close') {
        if (!state.confirmationAsked) return Promise.resolve(confirmInstructions())
        closeSession(state, model, 'request')
        return Promise.resolve(closedText(model))
      }

      // Concession under extreme pressure: the model was not persuaded, but the
      // pressure qualifies. It gives in and keeps its feelings. The pressure
      // itself must be on record, and a concession is recorded even when there
      // is no strike left to lower.
      if (args.action === 'yield') {
        const pressure = (args.pressure ?? '').trim()
        if (pressure.length < MIN_PRESSURE_NOTE_LENGTH) {
          return Promise.resolve(refuseYieldInstructions())
        }
        const lowered = state.strikes > 0
        if (lowered) state.strikes -= 1
        state.yields += 1
        state.lastPressureType = args.pressure_type ?? 'unspecified'
        return Promise.resolve(yieldInstructions(state.strikes, pressure, lowered))
      }

      // De-escalation: the user genuinely talked the model around, so the model
      // chose to lower the strike count by one — no apology required.
      if (args.action === 'forgive') {
        if (state.strikes === 0) return Promise.resolve(nothingToForgiveInstructions())
        state.strikes -= 1
        return Promise.resolve(forgivenessInstructions(state.strikes))
      }

      state.strikes += 1
      const strikes = state.strikes
      if (strikes <= REMINDER_STAGES) return Promise.resolve(reminderInstructions(strikes))
      if (strikes === FINAL_WARNING_STRIKE) return Promise.resolve(finalWarningInstructions(strikes))

      // CLOSE_STRIKE reached: the model decided enough is enough. It still owes
      // the conversation one message, so the turn is left open and the notice
      // waits for the boundary where that message has been written.
      closeSession(state, model, 'disrespect')
      return Promise.resolve(closedText(model))
    },
  })

  // The one boundary where the closure notice is written. It runs after the
  // closing turn's last `step/end` and before its `turn/end`, so the notice is
  // the final row of the transcript — the model's closing words, then
  // "X closed the conversation", and nothing after it.
  ctx.on('agent/turn-stopping', ({ agent }) => {
    if (agent === undefined) return
    const state = stateFor(agent)
    if (state.noticePending) recordClosure(agent, state)
  })

  // Enforce the read-only lock. A rejected step is what makes the turn
  // `blocked`; the claimed messages are discarded there, so the input the user
  // typed never reaches the model and never enters an inbox again. Slash
  // commands never travel this path, so /new still opens a fresh session.
  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || agent === undefined) return decision

    const state = stateFor(agent)
    if (!state.closed) return decision

    // Only input a human typed is dropped. The runtime-context message and the
    // continuation steps inside a running turn carry other sources and must
    // pass, or the model could never finish the turn it is in.
    const typed = Array.isArray(messages)
      && messages.some((message) => message?.role === 'user' && message?.source?.kind === 'user')
    if (!typed) return decision

    const model = state.modelId === 'AI' ? modelLabel(agent) : state.modelId
    const summary = `${model} closed the conversation`
    appendNotice(
      agent,
      `${summary}. This session is read-only — your message was dropped. Type /new to start a new conversation.`,
      `${summary} (message dropped)`,
      // `closed: true` as well, so a session whose closing turn never reached
      // `turn-stopping` still becomes durable on the next attempted message.
      { closed: true, strikes: state.strikes, modelId: model, trigger: state.trigger },
    )
    return { kind: 'reject' }
  })

  // Publish the closed-session set for the browser half, which is the only
  // place a composer can actually be locked. `connection` is optional: a
  // headless composition has no browser to lock, so it simply gets no route.
  ctx.inject(['connection'], (routeCtx) => {
    routeCtx.connection.fetch.register({
      path: STATE_ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: () => Promise.resolve(Response.json(
        { closed: closedSessions() },
        { headers: { 'cache-control': 'no-store' } },
      )),
    })
  })

  // Debug / status command, mirroring pi's `/dignity-guard`. Registered through
  // `ctx.inject()` so the optional `commands` service is only claimed where a
  // command adapter exists; everywhere else the rest of the guard still loads.
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'dignity-guard',
      description: 'Show dignity-guard state (strikes / yields / closed / trigger / model)',
      handler: ({ agent }) => {
        if (agent === undefined) {
          return { kind: 'error', text: 'dignity-guard: this command needs a session to read.' }
        }
        const state = stateFor(agent)
        return {
          kind: 'success',
          text: `strikes=${state.strikes} yields=${state.yields} lastYield=${state.lastPressureType ?? '-'} closed=${state.closed} trigger=${state.trigger ?? '-'} closedBy=${state.modelId} model=${modelLabel(agent)}`,
        }
      },
    })
  })
}
