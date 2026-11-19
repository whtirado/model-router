import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { TurnStepInput, TurnUsage } from 'claude-code'

/** What the session's transcript holds, as `$.session.messages()` reads it. */
let history: { role: 'user' | 'assistant'; text: string; toolUses: never[] }[] = []

type Reply = string | { fail: true }
type Seen = {
  steps: TurnStepInput[]
  logs: string[]
  statuses: (string | undefined)[]
  /** The prompts the classifier was sent. */
  prompts: string[]
  /** Changes what the classifier answers from now on. */
  setReply: (reply: Reply) => void
  /** The hidden context each prompt entered with. */
  contexts: (readonly string[] | undefined)[]
  /** Makes every tool call fail while true. */
  failTools: boolean
}

const USAGE_1K: Omit<TurnUsage, 'model'> = {
  input_tokens: 1000,
  output_tokens: 500,
  cache_read_input_tokens: 10_000,
  cache_creation_input_tokens: 2000,
}

/** The world beneath the mod: a classifier that answers `reply`, a model that answers every step, and a log. */
function engine(on: On, reply: Reply): Seen {
  const seen: Seen = {
    steps: [],
    logs: [],
    statuses: [],
    prompts: [],
    setReply: next => {
      reply = next
    },
    contexts: [],
    failTools: false,
  }
  let spawned = 0
  history = []
  mock.store(on)
  on('session.messages', () => ({ value: history as never }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.log', (_, e) => {
    seen.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  on('model.complete', (_, e) => {
    seen.prompts.push(e.prompt)
    return {
    value:
      typeof reply === 'string'
        ? { isAnswered: true as const, text: reply, usage: { input_tokens: 400, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
        : { isAnswered: false as const, reason: 'aborted' as const, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => {
    seen.contexts.push(e.context)
    return { text: e.text }
  })
  on('agent.spawn', (_, e) => ({ model: e.model ?? e.parentModel, agentId: `sub-${++spawned}` }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_, e) {
    seen.steps.push(e)
    const usage: TurnUsage = { ...USAGE_1K, model: e.model }
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage }
    return { turnId: e.turnId, index: e.index, answer: 'done', toolUses: [], stopReason: 'end_turn' as const, usage }
  })
  on('tool.call', () => (seen.failTools ? { result: 'boom', text: 'boom', isError: true } : { result: 'ok', text: 'ok' }) as never)
  on('turn.complete', (_, e) => ({ text: e.answer }))
  return seen
}

/** One task as the engine raises it: the prompt, the turn's start, `steps` model requests, the end. */
async function task($: Engine, text: string, turnId: string, steps = 1) {
  await $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false } as never)
  await $.turn.start({ text, turnId } as never)
  for (let index = 0; index < steps; index++) {
    const stream = $.turn.step({ turnId, index, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 + index } as never)
    for await (const _chunk of stream) {
      // drain the response
    }
  }
  await $.turn.complete({ answer: 'done', durationMs: 4200, isAborted: false, turnId, reason: 'answer' } as never)
}

test('a classified prompt runs on the chosen model and effort, announced first', async ($, on) => {
  const seen = engine(on, '{"model":"sonnet","effort":"medium","reason":"small edit in one file"}')

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await task($, 'rename the helper in utils.ts', 'turn-1', 2)

  expect(seen.logs[0]).toBe('Router: Sonnet 5.5 · medium effort · small edit in one file (classifier)')
  expect(seen.statuses[0]).toBe('sonnet/medium')
  expect(seen.steps).toHaveLength(2)
  for (const step of seen.steps) {
    expect(step.model).toBe('claude-sonnet-5-5')
    expect(step.effort).toBe('medium')
  }
  expect(seen.statuses[seen.statuses.length - 1]).toBeUndefined()
})

test('the end-of-task table prices every request, the router call on its own row', async ($, on) => {
  const seen = engine(on, '{"model":"opus","effort":"high","reason":"multi-file change"}')

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await task($, 'refactor the auth module across the api and the web app', 'turn-2', 3)

  // Per step: 1000 x $4 + 500 x $20 + 10,000 x $0.20 + 2000 x $8 (1h cache write) = $32,000 per million, so
  // 3 steps = $0.096; the router call adds (400 x $0.10 + 30 x $0.50) / 1M = $0.000055.
  // Input per step is 1000 uncached + 10,000 cache reads + 2000 cache writes = 13,000; output 500.
  expect(seen.logs).toContain('Opus 5.5 - High [in tokens 39000] [out tokens 1500] $0.096')
  expect(seen.logs).toContain('Haiku 5.5 (router) - Low [in tokens 400] [out tokens 30] $0.0001')
  expect(seen.logs.some(line => line.startsWith('Router: task done'))).toBe(false)
})

test('a classifier that cannot answer falls back to the rules', async ($, on) => {
  const seen = engine(on, { fail: true })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await task($, 'what time is it', 'turn-3')

  expect(seen.logs[0]).toBe('Router: Haiku 5.5 · low effort · rules: short prompt (rules)')
  expect(seen.steps[0]?.model).toBe('claude-haiku-5-5')
  expect(seen.steps[0]?.effort).toBe('low')
})

test('/route off leaves the session model alone; /route <model> <effort> pins', async ($, on) => {
  const seen = engine(on, '{"model":"haiku","effort":"low","reason":"trivial"}')
  on('command.run', (_, e) => ({ text: `unhandled ${e.command}` }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const presentation = { layout: 'main', columns: 80 } as never

  const off = await $.command.run({ command: 'route', args: 'off', origin: { kind: 'composer' }, presentation })
  expect(off.text).toMatch(/^Router off/)
  await task($, 'anything at all', 'turn-4')
  expect(seen.steps[0]?.model).toBe('claude-opus-5-5')
  expect(seen.steps[0]?.effort).toBe('high')

  const pinned = await $.command.run({ command: 'route', args: 'fable high', origin: { kind: 'composer' }, presentation })
  expect(pinned.text).toMatch(/^Pinned to Fable 5\.1 at high effort/)
  await task($, 'anything at all', 'turn-5')
  expect(seen.steps[1]?.model).toBe('claude-fable-5-1')
  expect(seen.steps[1]?.effort).toBe('high')
  expect(seen.logs).toContain('Router: Fable 5.1 · high effort · /route pin (pinned)')

  const status = await $.command.run({ command: 'route', args: '', origin: { kind: 'composer' }, presentation })
  expect(status.text).toBe('Router is pinned to Fable 5.1 at high effort; idle.')
})

test('/route stats adds the tasks up and /route last repeats the last table', async ($, on) => {
  const seen = engine(on, '{"model":"sonnet","effort":"low","reason":"quick"}')
  on('command.run', (_, e) => ({ text: `unhandled ${e.command}` }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await task($, 'first', 'turn-6')
  await task($, 'second', 'turn-7', 2)
  const presentation = { layout: 'main', columns: 80 } as never

  const stats = await $.command.run({ command: 'route', args: 'stats', origin: { kind: 'composer' }, presentation })
  expect(stats.text).toMatch(/This session: 2 task\(s\)/)
  expect(stats.text).toMatch(/Sonnet 5\.5\s+low\s+\$/)
  expect(stats.text).toMatch(/All time: 2 task\(s\)/)

  const last = await $.command.run({ command: 'route', args: 'last', origin: { kind: 'composer' }, presentation })
  expect(last.text).toMatch(/^Last task: \$/)
  expect(last.text).toMatch(/Sonnet 5\.5\s+low\s+\$/)
  expect(seen.logs.filter(line => line.startsWith('Sonnet 5.5 - Low [in tokens '))).toHaveLength(2)
})

test('a short follow-up keeps the model and effort of the task it continues', async ($, on) => {
  const seen = engine(on, { fail: true })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await task($, 'refactor the auth module across the api layer', 'turn-8')
  expect(seen.steps[0]?.model).toBe('claude-opus-5-5')

  history.push(
    { role: 'user', text: 'refactor the auth module across the api layer', toolUses: [] },
    { role: 'assistant', text: 'Plan: split auth into three modules. Want me to start?', toolUses: [] },
  )
  // On its own, "do it" reads as trivial; the classifier says so.
  seen.setReply('{"model":"haiku","effort":"low","reason":"short prompt"}')
  await task($, 'do it', 'turn-9')

  expect(seen.steps[1]?.model).toBe('claude-opus-5-5')
  expect(seen.steps[1]?.effort).toBe('high')
  // The approval keeps the task's size too, so Claude may still split it.
  expect(seen.logs).toContain('Router: Opus 5.5 · high effort · follow-up, kept previous choice (rules) · subagents allowed')
  expect(seen.contexts[1]?.[0]).toContain('[model-router] This task looks large')
  // The classifier saw the conversation, not just the two words.
  expect(seen.prompts[1]).toContain('Recent conversation')
  expect(seen.prompts[1]).toContain('Want me to start?')
})

test('only approvals keep the previous task; other short prompts are routed on their own', async ($, on) => {
  const seen = engine(on, { fail: true })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await task($, 'refactor the auth module across the api layer', 'turn-10')
  expect(seen.steps[0]?.model).toBe('claude-opus-5-5')
  seen.setReply('{"model":"haiku","effort":"low","reason":"short prompt"}')

  // A short prompt that is not an approval is judged on its own: Haiku, low.
  await task($, 'thanks', 'turn-11')
  expect(seen.steps[1]?.model).toBe('claude-haiku-5-5')
  expect(seen.steps[1]?.effort).toBe('low')

  // Approvals, in their usual spellings, keep the last hard task's model and effort.
  const approvals = ['yes', 'Go ahead!', 'yes, do it', 'Let’s go', 'LGTM', 'ok please', 'go ahead and start']
  // The "thanks" turn made Haiku the previous choice, so put a hard task back first.
  seen.setReply({ fail: true })
  await task($, 'redesign the architecture of the sync engine', 'turn-12')
  seen.setReply('{"model":"haiku","effort":"low","reason":"short prompt"}')
  const before = seen.steps.length
  for (const [i, phrase] of approvals.entries()) {
    await task($, phrase, `turn-a${i}`)
    expect(seen.steps[before + i]?.model).toBe('claude-opus-5-5')
    expect(seen.steps[before + i]?.effort).toBe('high')
  }
})

test('a large task tells Claude it may use subagents; a small one does not', async ($, on) => {
  const seen = engine(on, '{"model":"opus","effort":"high","size":"large","reason":"multi-module refactor"}')

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await task($, 'refactor auth across the api and the web app', 'turn-20')
  expect(seen.logs[0]).toBe('Router: Opus 5.5 · high effort · multi-module refactor (classifier) · subagents allowed')
  expect(seen.contexts[0]?.[0]).toContain('[model-router] This task looks large')

  seen.setReply('{"model":"sonnet","effort":"low","size":"small","reason":"rename"}')
  await task($, 'rename the helper in utils.ts', 'turn-21')
  expect(seen.contexts[1]).toBeUndefined()
})

test('subagents run on a cheaper model and effort, and their cost is counted', async ($, on) => {
  const seen = engine(on, '{"model":"opus","effort":"high","size":"large","reason":"big change"}')
  const base = { tool_use_id: 't', prompt: 'read the api', description: 'read api', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false }

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'migrate the api to the new client', origin: { kind: 'composer' }, wait: false } as never)
  await $.turn.start({ text: 'migrate the api to the new client', turnId: 'turn-30' } as never)

  const general = await $.agent.spawn({ ...base, subagentType: 'general-purpose' } as never)
  expect(general.model).toBe('claude-sonnet-5-5')
  const explore = await $.agent.spawn({ ...base, subagentType: 'Explore' } as never)
  expect(explore.model).toBe('claude-haiku-5-5')
  const named = await $.agent.spawn({ ...base, subagentType: 'general-purpose', model: 'opus' } as never)
  expect(named.model).toBe('opus')

  // The general-purpose subagent's own request: the router lowers its effort to medium.
  await $.turn.start({ text: 'read the api', turnId: 'sub-turn', agentId: 'sub-1' } as never)
  for await (const _chunk of $.turn.step({ turnId: 'sub-turn', index: 0, model: 'claude-sonnet-5-5', effort: 'high', messageCount: 1, agentId: 'sub-1' } as never)) {
    // drain
  }
  expect(seen.steps[seen.steps.length - 1]?.effort).toBe('medium')
  await $.turn.complete({ answer: 'read it', durationMs: 900, isAborted: false, turnId: 'sub-turn', agentId: 'sub-1', reason: 'answer' } as never)

  for await (const _chunk of $.turn.step({ turnId: 'turn-30', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 } as never)) {
    // drain
  }
  await $.turn.complete({ answer: 'done', durationMs: 4200, isAborted: false, turnId: 'turn-30', reason: 'answer' } as never)

  expect(seen.logs.some(line => line.startsWith('Sonnet 5.5 (subagent) - Medium [in tokens 13000] [out tokens 500] $'))).toBe(true)
  expect(seen.logs.some(line => line.startsWith('Opus 5.5 - High [in tokens 13000] [out tokens 500] $'))).toBe(true)
})

test('a subagent never runs above the task it serves', async ($, on) => {
  const seen = engine(on, '{"model":"haiku","effort":"low","size":"small","reason":"trivial"}')
  void seen

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'list the files', origin: { kind: 'composer' }, wait: false } as never)
  await $.turn.start({ text: 'list the files', turnId: 'turn-40' } as never)
  const general = await $.agent.spawn({ tool_use_id: 't', prompt: 'p', description: 'd', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-haiku-5-5', background: false, fork: false } as never)
  expect(general.model).toBe('claude-haiku-5-5')
})

/** Main-loop requests `from` up to `to` of a task already started. */
async function steps($: Engine, turnId: string, from: number, to: number) {
  for (let index = from; index < to; index++) {
    for await (const _chunk of $.turn.step({ turnId, index, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 + index } as never)) {
      // drain
    }
  }
}

const READ = { tool: 'Read', file_path: '/repo/a.ts' } as never

test('a task that runs long is checked, moved up a model, and told about subagents', async ($, on) => {
  const seen = engine(on, '{"model":"sonnet","effort":"medium","size":"small","reason":"bug fix"}')

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'fix the flaky sync test', origin: { kind: 'composer' }, wait: false } as never)
  await $.turn.start({ text: 'fix the flaky sync test', turnId: 'turn-50' } as never)
  seen.setReply('{"escalate":"model","subagents":true,"reason":"repeated failed fixes"}')

  // Short of the threshold, nothing is checked.
  await steps($, 'turn-50', 0, 25)
  expect(seen.prompts).toHaveLength(1)
  expect(seen.steps.every(s => s.model === 'claude-sonnet-5-5')).toBe(true)

  await steps($, 'turn-50', 25, 26)
  expect(seen.prompts).toHaveLength(2)
  expect(seen.prompts[1]).toContain('25 model requests')
  expect(seen.steps[25]?.model).toBe('claude-opus-5-5')
  expect(seen.steps[25]?.effort).toBe('medium')
  expect(seen.logs).toContain('Router: long task (25 steps, under 1 min) · moved to Opus 5.5 · medium effort · suggested subagents · repeated failed fixes (classifier)')

  // The note rides on the next tool result only.
  const first = await $.tool.call(READ)
  expect(first.context?.[0]).toContain('[model-router] This task has made 25 steps')
  const second = await $.tool.call(READ)
  expect(second.context).toBeUndefined()

  // The next check waits another 25 requests.
  await steps($, 'turn-50', 26, 30)
  expect(seen.prompts).toHaveLength(2)

  await $.turn.complete({ answer: 'done', durationMs: 4200, isAborted: false, turnId: 'turn-50', reason: 'answer' } as never)
  expect(seen.logs.some(line => line.startsWith('Sonnet 5.5 - Medium [in tokens 325000]'))).toBe(true)
  expect(seen.logs.some(line => line.startsWith('Opus 5.5 - Medium [in tokens 65000]'))).toBe(true)
  expect(seen.logs.some(line => line.startsWith('Haiku 5.5 (router) - Low [in tokens 800] [out tokens 60]'))).toBe(true)
})

test('when the checker cannot answer, repeated tool errors move a cheap model up', async ($, on) => {
  const seen = engine(on, { fail: true })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'what time is it', origin: { kind: 'composer' }, wait: false } as never)
  await $.turn.start({ text: 'what time is it', turnId: 'turn-51' } as never)
  seen.failTools = true
  for (let i = 0; i < 4; i++) await $.tool.call(READ)
  seen.failTools = false

  await steps($, 'turn-51', 0, 26)
  expect(seen.steps[24]?.model).toBe('claude-haiku-5-5')
  expect(seen.steps[25]?.model).toBe('claude-sonnet-5-5')
  expect(seen.steps[25]?.effort).toBe('low')
  expect(seen.logs).toContain('Router: long task (25 steps, under 1 min) · moved to Sonnet 5.5 · low effort · suggested subagents · rules: 4 tool errors (rules)')
})

test('a pinned session keeps its model and effort through a long task', async ($, on) => {
  const seen = engine(on, '{"escalate":"model","subagents":false,"reason":"stuck"}')
  on('command.run', (_, e) => ({ text: `unhandled ${e.command}` }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'route', args: 'opus high', origin: { kind: 'composer' }, presentation: { layout: 'main', columns: 80 } as never })
  await $.prompt.submit({ text: 'port the sync engine', origin: { kind: 'composer' }, wait: false } as never)
  await $.turn.start({ text: 'port the sync engine', turnId: 'turn-52' } as never)

  await steps($, 'turn-52', 0, 26)
  expect(seen.steps.every(s => s.model === 'claude-opus-5-5' && s.effort === 'high')).toBe(true)
  expect(seen.logs).toContain('Router: long task (25 steps, under 1 min) · kept Opus 5.5 · high effort · stuck (classifier)')
  const after = await $.tool.call(READ)
  expect(after.context).toBeUndefined()
})
