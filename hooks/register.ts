import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnUsage } from 'claude-code'

import type {
  RouterChoice,
  RouterEffort,
  RouterModelName,
  RouterPin,
  RouterScope,
  RouterTally,
  RouterTaskReport,
  RouterUsageRow,
} from '../types'

// ---------------------------------------------------------------------------
// Models and prices
// ---------------------------------------------------------------------------

const MODELS: Record<RouterModelName, { id: string; label: string }> = {
  haiku: { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  sonnet: { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  opus: { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  fable: { id: 'claude-fable-5-1', label: 'Fable 5.1' },
}

const MODEL_NAMES: RouterModelName[] = ['haiku', 'sonnet', 'opus', 'fable']
const EFFORTS: RouterEffort[] = ['low', 'medium', 'high']

/** Dollars per million tokens, first-party API rates as of 2026-10-06. */
type Price = { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number }

const PRICES: Record<RouterModelName, Price> = {
  haiku: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2 },
  sonnet: { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  opus: { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
  fable: { input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 },
}

/** Haiku 5.5 charges five times the rate once a prompt passes this many tokens. */
const HAIKU_LONG_PROMPT = 100_000

export const PRICES_DATED = '2026-10-06'

export function modelNameOf(apiModel: string): RouterModelName | undefined {
  const id = apiModel.toLowerCase()
  if (id.includes('haiku')) return 'haiku'
  if (id.includes('sonnet')) return 'sonnet'
  if (id.includes('opus')) return 'opus'
  if (id.includes('fable') || id.includes('mythos')) return 'fable'
  return undefined
}

export function labelOf(apiModel: string): string {
  const name = modelNameOf(apiModel)
  return name ? MODELS[name].label : apiModel
}

/** The dollars one request's four counts come to; 0 for a model the table has no row for. */
export function costOf(
  apiModel: string,
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number },
  cacheTtl: '5m' | '1h',
): number {
  const name = modelNameOf(apiModel)
  if (!name) return 0
  const price = PRICES[name]
  const promptTokens = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  const tier = name === 'haiku' && promptTokens > HAIKU_LONG_PROMPT ? 5 : 1
  const cacheWrite = cacheTtl === '1h' ? price.cacheWrite1h : price.cacheWrite5m
  const dollars =
    usage.input_tokens * price.input +
    usage.output_tokens * price.output +
    usage.cache_read_input_tokens * price.cacheRead +
    usage.cache_creation_input_tokens * cacheWrite
  return (dollars * tier) / 1_000_000
}

// ---------------------------------------------------------------------------
// Choosing
// ---------------------------------------------------------------------------

const CLASSIFIER_MODEL = 'claude-haiku-5-5'
const CLASSIFIER_TIMEOUT_MS = 8000

const CLASSIFIER_SYSTEM = `You route a coding assistant's next task to a model and an effort level. Answer with one JSON object and nothing else:
{"model":"haiku|sonnet|opus|fable","effort":"low|medium|high","size":"small|large","reason":"<at most 12 words>"}

Models, cheapest to most capable:
- haiku: trivial lookups, one-line answers, renames, formatting, reading a file back, simple factual questions.
- sonnet: everyday coding: a small or medium edit, a script, a clear explanation, tests for known code.
- opus: multi-file changes, debugging with an unclear cause, design choices, code review, careful research.
- fable: the hardest work: architecture, subtle concurrency or security bugs, long autonomous tasks, anything where being wrong is expensive.

Effort:
- low: short, mechanical, or the answer is obvious.
- medium: typical work with some judgment.
- high: ambiguous, risky, multi-step, or needs verification.

Size:
- large: spans several files or modules, needs a broad investigation, or has parts that could be done independently and in parallel.
- small: everything else, including approvals of small work.

Pick the cheapest model that will do the job well. A short prompt can still be hard; a long prompt can still be easy.

You are usually given the recent conversation before the new prompt. Route the work the new prompt asks for, not its wording. A short prompt such as "do it", "yes", "go ahead", "continue" or "looks good" means start or continue the task already discussed, so judge that task's difficulty. Never choose haiku for a prompt that approves or continues substantial work.`

type Classified = { choice: RouterChoice; usage: TurnUsage | null }

export function parseChoice(text: string): RouterChoice | undefined {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return undefined
  try {
    const parsed = JSON.parse(match[0]) as { model?: unknown; effort?: unknown; size?: unknown; reason?: unknown }
    const model = String(parsed.model ?? '').toLowerCase() as RouterModelName
    const effort = String(parsed.effort ?? '').toLowerCase() as RouterEffort
    if (!MODEL_NAMES.includes(model) || !EFFORTS.includes(effort)) return undefined
    const reason = typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim() : 'classifier'
    const large = String(parsed.size ?? '').toLowerCase() === 'large'
    return { model, effort, reason, source: 'classifier', ...(large ? { large: true } : {}) }
  } catch {
    return undefined
  }
}

/** Approvals only: replies whose whole meaning is "go ahead with what we just discussed". */
const APPROVAL =
  /^(?:(?:yes|yeah|yep|yup|ok|okay|sure|alright|please|and)\s+)*(?:yes|yeah|yep|yup|y|ok|okay|sure|go|go ahead(?: and (?:do it|start|build it|implement it|proceed))?|go for it|do it|do that|do so|proceed|continue|carry on|keep going|sounds good|sounds great|looks good|lgtm|ship it|start|start it|let'?s go|let'?s do it|let'?s do this|make it so|run it|build it|implement it|implement that|that works|perfect|approved)(?:\s+(?:please|now|then))?$/

export function isFollowUp(text: string): boolean {
  const cleaned = text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned !== '' && APPROVAL.test(cleaned)
}

function keepPrevious(previous: RouterChoice): RouterChoice {
  return {
    model: previous.model,
    effort: previous.effort,
    reason: 'follow-up, kept previous choice',
    source: 'rules',
    ...(previous.large ? { large: true } : {}),
  }
}

/** A follow-up never drops below the model and effort of the task it continues. */
export function floorFollowUp(choice: RouterChoice, text: string, previous?: RouterChoice): RouterChoice {
  if (!previous || !isFollowUp(text)) return choice
  const lower = MODEL_NAMES.indexOf(choice.model) < MODEL_NAMES.indexOf(previous.model) || EFFORTS.indexOf(choice.effort) < EFFORTS.indexOf(previous.effort)
  return lower ? keepPrevious(previous) : choice
}

/** The fallback when the classifier is unavailable: cheap keyword and length rules. */
export function chooseByRules(text: string, previous?: RouterChoice): RouterChoice {
  if (previous && isFollowUp(text)) return keepPrevious(previous)
  const words = text.trim().split(/\s+/).filter(Boolean).length
  const lower = text.toLowerCase()
  const hard = /\b(architect|architecture|redesign|refactor|migrat|security|race condition|deadlock|concurren|performance|optimi[sz]e|audit|review)\b/
  const fix = /\b(fix|bug|error|fail|broken|crash|exception|debug|why does|doesn't work|not working)\b/
  const code = /```|\bfunction\b|\bclass\b|\bimport\b|=>/
  if (hard.test(lower)) return { model: 'opus', effort: 'high', reason: 'rules: design or risk keywords', source: 'rules', large: true }
  if (fix.test(lower)) return { model: 'opus', effort: 'medium', reason: 'rules: debugging keywords', source: 'rules' }
  if (words <= 12 && !code.test(text)) return { model: 'haiku', effort: 'low', reason: 'rules: short prompt', source: 'rules' }
  if (words >= 150) return { model: 'opus', effort: 'medium', reason: 'rules: long prompt', source: 'rules', large: true }
  return { model: 'sonnet', effort: 'medium', reason: 'rules: everyday task', source: 'rules' }
}

// ---------------------------------------------------------------------------
// Subagents
// ---------------------------------------------------------------------------

/** What the model reads beside a large task's prompt; the person never sees it. */
export const SUBAGENT_NOTE =
  '[model-router] This task looks large. Where parts of it are independent, such as searching or reading many files, separate modules, or separate investigations, hand those parts to subagents with the Agent tool and run them in parallel, then combine their results yourself. Keep planning, final decisions and edits that depend on each other in the main thread. Do not split small or tightly coupled work.'

/** A subagent's model and effort: cheap for its type by default, never above the task it serves. */
export function subagentChoice(main: RouterChoice, subagentType: string): { model: RouterModelName; effort: RouterEffort } {
  const type = subagentType.toLowerCase()
  const wanted: { model: RouterModelName; effort: RouterEffort } =
    type === 'explore'
      ? { model: 'haiku', effort: 'low' }
      : type === 'plan'
        ? { model: main.model, effort: main.effort }
        : { model: 'sonnet', effort: 'medium' }
  // Both indexes are of names in the lists, so the lower one is too.
  const model = MODEL_NAMES[Math.min(MODEL_NAMES.indexOf(wanted.model), MODEL_NAMES.indexOf(main.model))]!
  const effort = EFFORTS[Math.min(EFFORTS.indexOf(wanted.effort), EFFORTS.indexOf(main.effort))]!
  return { model, effort }
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/** The last few messages of the conversation, so a prompt is judged in context. */
async function recentContext($: EngineInterface): Promise<string> {
  try {
    const all = await $.session.messages()
    return all
      .filter(m => m.text.trim() !== '')
      .slice(-6)
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text.length > 700 ? `${m.text.slice(0, 700)} [...]` : m.text}`)
      .join('\n\n')
  } catch {
    return ''
  }
}

/** Asks Haiku for a choice; falls back to the rules when it cannot answer in time. */
async function classify($: EngineInterface, text: string, attachments: number, previous?: RouterChoice): Promise<Classified> {
  const body = text.length > 6000 ? `${text.slice(0, 6000)}\n[... ${text.length - 6000} more characters]` : text
  const history = await recentContext($)
  const prompt = `${history ? `Recent conversation, oldest first:\n${history}\n\n---\n` : ''}New prompt to route${attachments > 0 ? ` [${attachments} attachment(s)]` : ''}:\n${body}`
  try {
    const r = await $.model.complete({
      model: CLASSIFIER_MODEL,
      system: CLASSIFIER_SYSTEM,
      prompt,
      effort: 'low',
      maxTokens: 120,
      timeoutMs: CLASSIFIER_TIMEOUT_MS,
    })
    const usage: TurnUsage = { ...r.usage, model: CLASSIFIER_MODEL }
    if (r.isAnswered) {
      const parsed = parseChoice(r.text)
      if (parsed) return { choice: floorFollowUp(parsed, text, previous), usage }
    }
    return { choice: chooseByRules(text, previous), usage }
  } catch {
    return { choice: chooseByRules(text, previous), usage: null }
  }
}

// ---------------------------------------------------------------------------
// Long-task check
// ---------------------------------------------------------------------------

/** A task is checked once it has made this many model requests, and again every as many more. */
export const LONG_TASK_STEPS = 25
/** Or once it has run this long, and again every as long after. */
export const LONG_TASK_MS = 5 * 60_000
/** At most this many checks per task. */
export const LONG_TASK_MAX_CHECKS = 3
/** This many failed tool calls reads as stuck when the checker cannot answer. */
const STUCK_TOOL_ERRORS = 4

/** How far a running task has got. */
export type Progress = { steps: number; elapsedMs: number; toolErrors: number; subagents: number }

/** What a long-task check decided. */
export type Verdict = {
  escalate: 'none' | 'effort' | 'model'
  subagents: boolean
  reason: string
  source: 'classifier' | 'rules'
}

const CHECK_SYSTEM = `You watch a coding assistant's task that is taking a long time and decide whether it needs help. Answer with one JSON object and nothing else:
{"escalate":"none|effort|model","subagents":true|false,"reason":"<= 8 words"}

escalate:
- "none": the task is big but making steady progress. Long is not the same as stuck; prefer this when unsure.
- "effort": the model can do this but is rushing, guessing or repeating itself; more thinking would help.
- "model": the task is beyond the current model: repeated failed attempts, many tool errors, confusion about the code.

subagents:
- true: the remaining work has independent parts (searching or reading many files, separate modules, separate investigations) and few or no subagents were used so far.
- false: the work is sequential or tightly coupled, or subagents are already in use.`

export function parseVerdict(text: string): Omit<Verdict, 'source'> | undefined {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return undefined
  try {
    const raw = JSON.parse(match[0]) as { escalate?: unknown; subagents?: unknown; reason?: unknown }
    const escalate = raw.escalate === 'effort' || raw.escalate === 'model' || raw.escalate === 'none' ? raw.escalate : undefined
    if (!escalate) return undefined
    const reason = typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason.trim().slice(0, 80) : 'long task check'
    return { escalate, subagents: raw.subagents === true, reason }
  } catch {
    return undefined
  }
}

/** The check without the checker: many tool errors read as stuck; no subagents yet reads as worth suggesting. */
export function verdictByRules(progress: Progress, model: RouterModelName): Verdict {
  const stuck = progress.toolErrors >= STUCK_TOOL_ERRORS
  return {
    escalate: stuck ? (model === 'haiku' ? 'model' : 'effort') : 'none',
    subagents: progress.subagents === 0,
    reason: stuck ? `rules: ${progress.toolErrors} tool errors` : 'rules: long but progressing',
    source: 'rules',
  }
}

/** One step up: more effort first when asked, else the next model; undefined at the top. */
export function escalateChoice(choice: RouterChoice, kind: Verdict['escalate'], reason: string): RouterChoice | undefined {
  if (kind === 'none') return undefined
  const nextEffort = EFFORTS[EFFORTS.indexOf(choice.effort) + 1]
  const nextModel = MODEL_NAMES[MODEL_NAMES.indexOf(choice.model) + 1]
  const raised = `long task: ${reason}`
  if (kind === 'effort' && nextEffort) return { ...choice, effort: nextEffort, reason: raised }
  if (nextModel) return { ...choice, model: nextModel, reason: raised }
  if (nextEffort) return { ...choice, effort: nextEffort, reason: raised }
  return undefined
}

export function progressText(progress: Progress): string {
  const minutes = progress.elapsedMs < 60_000 ? 'under 1 min' : `${Math.round(progress.elapsedMs / 60_000)} min`
  return `${progress.steps} steps, ${minutes}`
}

/** What Claude reads, after its next tool result, when the check suggests subagents. */
export function longTaskNote(progress: Progress): string {
  return `[model-router] This task has made ${progressText(progress)} so far. If the remaining work splits into independent parts, such as searching or reading many files, separate modules, or separate investigations, hand those parts to subagents with the Agent tool and run them in parallel, then combine their results yourself. Keep dependent edits and final decisions in the main thread.`
}

/** Asks Haiku whether a long task needs a stronger model or subagents; falls back to the rules. */
async function checkProgress($: EngineInterface, choice: RouterChoice, progress: Progress): Promise<{ verdict: Verdict; usage: TurnUsage | null }> {
  const history = await recentContext($)
  const minutes = Math.max(1, Math.round(progress.elapsedMs / 60_000))
  const prompt = `${history ? `Recent conversation, oldest first:\n${history}\n\n---\n` : ''}The task runs on ${MODELS[choice.model].label} at ${choice.effort} effort. So far: ${progress.steps} model requests over ${minutes} minute(s), ${progress.toolErrors} failed tool call(s), ${progress.subagents} subagent(s) started.`
  try {
    const r = await $.model.complete({
      model: CLASSIFIER_MODEL,
      system: CHECK_SYSTEM,
      prompt,
      effort: 'low',
      maxTokens: 100,
      timeoutMs: CLASSIFIER_TIMEOUT_MS,
    })
    const usage: TurnUsage = { ...r.usage, model: CLASSIFIER_MODEL }
    const parsed = r.isAnswered ? parseVerdict(r.text) : undefined
    return { verdict: parsed ? { ...parsed, source: 'classifier' } : verdictByRules(progress, choice.model), usage }
  } catch {
    return { verdict: verdictByRules(progress, choice.model), usage: null }
  }
}

// ---------------------------------------------------------------------------
// Accounting
// ---------------------------------------------------------------------------

type Task = {
  rows: Map<string, RouterUsageRow>
  startedAt: number
  /** Model requests the main loop has made. */
  steps: number
  toolErrors: number
  subagents: number
  /** Long-task checks made, and when the next one is due. */
  checks: number
  nextCheckStep: number
  nextCheckAt: number
  /** A note for Claude, waiting for the next tool result. */
  note?: string
}

function rowKey(scope: RouterScope, model: string, effort: string): string {
  return `${scope}/${model}/${effort}`
}

function addUsage(rows: Map<string, RouterUsageRow>, scope: RouterScope, effort: string, usage: TurnUsage, cacheTtl: '5m' | '1h'): void {
  const key = rowKey(scope, usage.model, effort)
  const row = rows.get(key) ?? { scope, model: usage.model, effort, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
  row.requests += 1
  row.input += usage.input_tokens
  row.output += usage.output_tokens
  row.cacheRead += usage.cache_read_input_tokens
  row.cacheWrite += usage.cache_creation_input_tokens
  row.cost += costOf(usage.model, usage, cacheTtl)
  rows.set(key, row)
}

function emptyTally(): RouterTally {
  return { tasks: 0, rows: {}, total: 0 }
}

export function foldReport(tally: RouterTally, report: RouterTaskReport): RouterTally {
  const rows: Record<string, RouterUsageRow> = { ...tally.rows }
  for (const row of report.rows) {
    const key = rowKey(row.scope, row.model, row.effort)
    const had = rows[key]
    rows[key] = had
      ? {
          ...had,
          requests: had.requests + row.requests,
          input: had.input + row.input,
          output: had.output + row.output,
          cacheRead: had.cacheRead + row.cacheRead,
          cacheWrite: had.cacheWrite + row.cacheWrite,
          cost: had.cost + row.cost,
        }
      : { ...row }
  }
  return { tasks: tally.tasks + 1, rows, total: tally.total + report.total }
}

const SCOPE_ORDER: Record<RouterScope, number> = { task: 0, subagent: 1, router: 2 }

function sortRows(rows: Iterable<RouterUsageRow>): RouterUsageRow[] {
  return [...rows].sort((a, b) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] || b.cost - a.cost)
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function dollars(n: number): string {
  if (n === 0) return '$0'
  if (n < 0.01) return `$${n.toFixed(4)}`
  if (n < 1) return `$${n.toFixed(3)}`
  return `$${n.toFixed(2)}`
}

function pad(text: string, width: number, align: 'left' | 'right'): string {
  if (text.length >= width) return text
  const fill = ' '.repeat(width - text.length)
  return align === 'left' ? text + fill : fill + text
}

function rowLabel(row: RouterUsageRow): string {
  const label = labelOf(row.model)
  if (row.scope === 'router') return `${label} (router)`
  if (row.scope === 'subagent') return `${label} (subagent)`
  return label
}

export function formatTable(rows: RouterUsageRow[], total: number, title: string): string {
  const header = ['Model', 'Effort', 'Cost']
  const lines = rows.map(row => [rowLabel(row), row.effort, dollars(row.cost)])
  const totalLine = ['Total', '', dollars(total)]
  const all = [header, ...lines, totalLine]
  // Every line has the header's three cells, so each index below is in range.
  const widths = header.map((_, i) => Math.max(...all.map(line => line[i]!.length)))
  const render = (line: string[]) => line.map((cell, i) => pad(cell, widths[i]!, i === 2 ? 'right' : 'left')).join('  ')
  const out = [title, render(header), render(widths.map(w => '-'.repeat(w)))]
  for (const line of lines) out.push(render(line))
  out.push(render(totalLine))
  return out.join('\n')
}

function describe(choice: RouterChoice): string {
  const how = choice.source === 'pinned' ? 'pinned' : choice.source === 'rules' ? 'rules' : 'classifier'
  return `${MODELS[choice.model].label} · ${choice.effort} effort · ${choice.reason} (${how})${choice.large ? ' · subagents allowed' : ''}`
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const pending = atom({ plugin: 'model-router', key: 'pending' } as const, null as RouterChoice | null, { shape: 'choice-1' })
const current = atom({ plugin: 'model-router', key: 'current' } as const, null as RouterChoice | null, { shape: 'choice-1' })
const pin = atom({ plugin: 'model-router', key: 'pin' } as const, { kind: 'auto' } as RouterPin, { shape: 'pin-1' })
const sessionTally = atom({ plugin: 'model-router', key: 'session' } as const, emptyTally(), { shape: 'tally-1' })
const last = atom({ plugin: 'model-router', key: 'last' } as const, null as RouterTaskReport | null, { shape: 'report-1' })

const ALL_TIME_KEY = 'all-time-1'

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export const register: Register = (on, options) => {
  const cacheTtl: '5m' | '1h' = options.cacheTtl === '5m' ? '5m' : '1h'

  /** The usage of the classifier call made for the turn about to start. */
  let routerUsage: TurnUsage | null = null
  /** The last choice made, so a short follow-up ("do it") keeps the task's model and effort. */
  let lastChoice: RouterChoice | undefined
  /** Open tasks by the main loop's turn id, and which main turn each subagent turn rolls into. */
  const tasks = new Map<string, Task>()
  const parentOf = new Map<string, string>()
  let runningMain: string | undefined
  /** The effort each subagent the router placed runs at, by its agent id. */
  const subagentEffort = new Map<string, RouterEffort>()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'route',
      description: 'Model router: status, off, auto, <model> [effort], stats, last, reset',
      argumentHint: 'status | off | auto | haiku|sonnet|opus|fable [low|medium|high] | stats | last | reset',
    })
    return next(e)
  })

  // 1. Classify the prompt before its turn starts.
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta || e.turnId !== undefined || !e.text.trim()) return next(e)
    const standing = await read($, pin)
    if (standing.kind === 'off') return next(e)

    let choice: RouterChoice
    routerUsage = null
    if (standing.kind === 'pinned' && standing.effort) {
      choice = { model: standing.model, effort: standing.effort, reason: '/route pin', source: 'pinned' }
    } else {
      const classified = await classify($, e.text, e.attachments?.length ?? 0, lastChoice)
      routerUsage = classified.usage
      choice = classified.choice
      if (standing.kind === 'pinned') choice = { ...choice, model: standing.model, source: 'pinned', reason: `/route pin; ${choice.reason}` }
    }

    lastChoice = choice
    await update($, pending, () => choice)
    $.ui.log(`Router: ${describe(choice)}`)
    $.ui.status(`${choice.model}/${choice.effort}`)
    if (choice.large) return next({ ...e, context: [...(e.context ?? []), SUBAGENT_NOTE] })
    return next(e)
  }).catch(($, e, next) => next(e))

  // 2. Take the choice up when the turn starts; map subagent turns to the task they belong to.
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) {
      if (runningMain !== undefined) parentOf.set(e.turnId, runningMain)
      return next(e)
    }
    const choice = await read($, pending)
    await update($, pending, () => null)
    await update($, current, () => choice)
    const startedAt = await $.clock.now()
    const task: Task = {
      rows: new Map(),
      startedAt,
      steps: 0,
      toolErrors: 0,
      subagents: 0,
      checks: 0,
      nextCheckStep: LONG_TASK_STEPS,
      nextCheckAt: startedAt + LONG_TASK_MS,
    }
    if (routerUsage) {
      addUsage(task.rows, 'router', 'low', routerUsage, cacheTtl)
      routerUsage = null
    }
    tasks.set(e.turnId, task)
    runningMain = e.turnId
    return next(e)
  })

  // 2b. Put each subagent of a routed task on a cheaper model, unless Claude named one itself.
  on('agent.spawn', async ($, e, next) => {
    const running = runningMain === undefined ? undefined : tasks.get(runningMain)
    if (running) running.subagents++
    if (e.fork || e.isTeammate || e.workflow || e.model !== undefined) return next(e)
    const main = await read($, current)
    if (!main) return next(e)
    const sub = subagentChoice(main, e.subagentType)
    const started = await next({ ...e, model: MODELS[sub.model].id })
    if (started.deny === undefined && started.agentId) subagentEffort.set(started.agentId, sub.effort)
    return started
  }).catch(($, e, next) => next(e))

  // 3. Send each request of the task on the chosen model and effort; count what it cost.
  on('turn.step', async function* ($, e, next) {
    let request = e
    let scope: RouterScope = 'subagent'
    let task = tasks.get(e.turnId)
    if (e.agentId === undefined) {
      scope = 'task'
      let choice = await read($, current)
      if (task) {
        const now = await $.clock.now()
        if (choice && task.checks < LONG_TASK_MAX_CHECKS && (task.steps >= task.nextCheckStep || now >= task.nextCheckAt)) {
          task.checks++
          task.nextCheckStep = task.steps + LONG_TASK_STEPS
          task.nextCheckAt = now + LONG_TASK_MS
          const progress: Progress = { steps: task.steps, elapsedMs: now - task.startedAt, toolErrors: task.toolErrors, subagents: task.subagents }
          const standing = await read($, pin)
          const checked = await checkProgress($, choice, progress)
          if (checked.usage) addUsage(task.rows, 'router', 'low', checked.usage, cacheTtl)
          const verdict = checked.verdict
          // A pinned session keeps its model and effort; the check may still suggest subagents.
          const raised = standing.kind === 'auto' ? escalateChoice(choice, verdict.escalate, verdict.reason) : undefined
          if (raised) {
            choice = raised
            lastChoice = raised
            await update($, current, () => raised)
            $.ui.status(`${raised.model}/${raised.effort}`)
          }
          if (verdict.subagents) task.note = longTaskNote(progress)
          const moved = raised
            ? `moved to ${MODELS[raised.model].label} · ${raised.effort} effort`
            : `kept ${MODELS[choice.model].label} · ${choice.effort} effort`
          $.ui.log(`Router: long task (${progressText(progress)}) · ${moved}${verdict.subagents ? ' · suggested subagents' : ''} · ${verdict.reason} (${verdict.source})`)
        }
        task.steps++
      }
      if (choice) request = { ...e, model: MODELS[choice.model].id, effort: choice.effort }
    } else {
      const parent = parentOf.get(e.turnId)
      task = parent ? tasks.get(parent) : undefined
      const subEffort = subagentEffort.get(e.agentId)
      if (subEffort) request = { ...e, effort: subEffort }
    }
    const result = yield* next(request)
    if (task && result.usage) addUsage(task.rows, scope, String(request.effort ?? 'default'), result.usage, cacheTtl)
    return result
  })

  // 3b. Count the task's failed tool calls, and hand Claude the long-task note with its next tool result.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    const task = runningMain === undefined ? undefined : tasks.get(runningMain)
    if (e.agentId !== undefined || !task) return result
    if (result.isError) task.toolErrors++
    if (task.note && result.deny === undefined) {
      const note = task.note
      task.note = undefined
      return { ...result, context: [...(result.context ?? []), note] }
    }
    return result
  })

  // 4. Report when the task ends.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      parentOf.delete(e.turnId)
      return next(e)
    }
    const task = tasks.get(e.turnId)
    // A turn the router never saw start is not its to close.
    if (!task) return next(e)
    tasks.delete(e.turnId)
    if (runningMain === e.turnId) runningMain = undefined
    await update($, current, () => null)
    $.ui.status(undefined)

    const rows = sortRows(task.rows.values())
    const total = rows.reduce((n, r) => n + r.cost, 0)
    const report: RouterTaskReport = { turnId: e.turnId, rows, total }
    await update($, last, () => report)
    await update($, sessionTally, t => foldReport(t, report))
    try {
      const stored = (await $.store.get(ALL_TIME_KEY)) as RouterTally | undefined
      await $.store.set(ALL_TIME_KEY, foldReport(stored ?? emptyTally(), report))
    } catch {
      // The all-time tally is best effort; the session tally above already has the task.
    }

    for (const row of rows) {
      const effort = `${row.effort.charAt(0).toUpperCase()}${row.effort.slice(1)}`
      // Input counts every prompt token the model read: uncached, cache reads and cache writes.
      const input = row.input + row.cacheRead + row.cacheWrite
      $.ui.log(`${rowLabel(row)} - ${effort} [in tokens ${input}] [out tokens ${row.output}] ${dollars(row.cost)}`)
    }
    return next(e)
  })

  // 5. /route
  on('command.run', { command: 'route' }, async ($, e) => {
    const words = e.args.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const verb = words[0] ?? 'status'
    const arg = words[1]
    const standing = await read($, pin)

    if (verb === 'status') {
      const now = await read($, current)
      const next = await read($, pending)
      const mode = standing.kind === 'auto' ? 'auto' : standing.kind === 'off' ? 'off' : `pinned to ${MODELS[standing.model].label}${standing.effort ? ` at ${standing.effort} effort` : ''}`
      const running = now ? `running on ${describe(now)}` : next ? `next: ${describe(next)}` : 'idle'
      return { text: `Router is ${mode}; ${running}.` }
    }
    if (verb === 'off') {
      await update($, pin, () => ({ kind: 'off' }) as RouterPin)
      return { text: 'Router off: turns run on the session model and effort.' }
    }
    if (verb === 'auto' || verb === 'on') {
      await update($, pin, () => ({ kind: 'auto' }) as RouterPin)
      return { text: 'Router on: each prompt is classified.' }
    }
    if (MODEL_NAMES.includes(verb as RouterModelName)) {
      const model = verb as RouterModelName
      const effort = arg && EFFORTS.includes(arg as RouterEffort) ? (arg as RouterEffort) : undefined
      if (arg && !effort) return { text: `Unknown effort "${arg}": use low, medium or high.` }
      await update($, pin, () => ({ kind: 'pinned', model, ...(effort ? { effort } : {}) }) as RouterPin)
      return { text: `Pinned to ${MODELS[model].label}${effort ? ` at ${effort} effort` : ' (effort still classified)'} for this session. /route auto to unpin.` }
    }
    if (verb === 'stats') {
      const session = await read($, sessionTally)
      let allTime: RouterTally | undefined
      try {
        allTime = (await $.store.get(ALL_TIME_KEY)) as RouterTally | undefined
      } catch {
        allTime = undefined
      }
      const parts = [formatTable(sortRows(Object.values(session.rows)), session.total, `This session: ${session.tasks} task(s)`)]
      if (allTime) parts.push('', formatTable(sortRows(Object.values(allTime.rows)), allTime.total, `All time: ${allTime.tasks} task(s)`))
      parts.push(`API-equivalent at ${PRICES_DATED} rates, ${cacheTtl} cache.`)
      return { text: parts.join('\n') }
    }
    if (verb === 'last') {
      const report = await read($, last)
      if (!report) return { text: 'No task has finished yet.' }
      return { text: formatTable(report.rows, report.total, `Last task: ${dollars(report.total)}`) }
    }
    if (verb === 'reset') {
      await update($, sessionTally, () => emptyTally())
      try {
        await $.store.delete(ALL_TIME_KEY)
      } catch {
        // nothing stored
      }
      return { text: 'Router tallies reset.' }
    }
    return { text: 'Usage: /route [status | off | auto | haiku|sonnet|opus|fable [low|medium|high] | stats | last | reset]' }
  })
}
