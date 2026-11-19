/** The models the router chooses between, by the short name it announces. */
export type RouterModelName = 'haiku' | 'sonnet' | 'opus' | 'fable'

/** The effort levels the router chooses between. */
export type RouterEffort = 'low' | 'medium' | 'high'

/** One routing decision: what the next turn runs on, and why. */
export type RouterChoice = {
  model: RouterModelName
  effort: RouterEffort
  reason: string
  /** Where the choice came from: the classifier, the fallback rules, or a /route pin. */
  source: 'classifier' | 'rules' | 'pinned'
  /** True when the task is large enough to hand independent parts to subagents. */
  large?: boolean
}

/** Whose requests a row counts: the task's own, a subagent's, or the router's classifier call. */
export type RouterScope = 'task' | 'subagent' | 'router'

/** The four token counts the API reports for one model and effort, plus the dollars they came to. */
export type RouterUsageRow = {
  scope: RouterScope
  /** The model as the API reported it (`claude-sonnet-5-5`). */
  model: string
  effort: string
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
}

/** What one task (turn) cost, by model and effort, including the router's own call. */
export type RouterTaskReport = {
  turnId: string
  rows: RouterUsageRow[]
  total: number
}

/** Session-wide and all-time tallies, keyed by `${scope}/${model}/${effort}`. */
export type RouterTally = {
  tasks: number
  rows: Record<string, RouterUsageRow>
  total: number
}

/** What /route pins for the rest of the session, or that routing is off. */
export type RouterPin =
  | { kind: 'auto' }
  | { kind: 'off' }
  | { kind: 'pinned'; model: RouterModelName; effort?: RouterEffort }

declare module 'claude-code' {
  interface PluginState {
    'model-router': {
      /** The choice for the turn about to start, taken up when it starts. */
      pending: Shaped<RouterChoice | null>
      /** The choice the running turn runs on. */
      current: Shaped<RouterChoice | null>
      /** The session's standing override. */
      pin: Shaped<RouterPin>
      /** The session's running totals. */
      session: Shaped<RouterTally>
      /** The last finished task's report, for /route last. */
      last: Shaped<RouterTaskReport | null>
    }
  }
}
