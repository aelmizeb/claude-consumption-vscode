/** State of a loop: the main conversation (`main`) or a sub-agent. */
export type FleetStatus = 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed'

/** Tokens consumed by a loop, as the API reports them on every request. */
export type FleetUsage = {
  input: number
  output: number
  cacheRead: number
  /** Tokens written to the cache, every duration included. */
  cacheWrite: number
  /** Part of `cacheWrite` written for one hour (billed twice the input price). */
  cacheWrite1h: number
}

/** A loop the panel follows: the main conversation or a sub-agent, with its tokens and current tool. */
export type FleetLoop = {
  /** `main` for the main conversation, otherwise the sub-agent id. */
  id: string
  /** `main`, or the agent type (`general-purpose`, `Explore`, `fork`, …). */
  type: string
  /** The task description (a few words), empty for the main loop. */
  description: string
  status: FleetStatus
  /** Timestamps in milliseconds (epoch). */
  startedAt: number
  endedAt?: number
  /** Number of model requests made by the loop. */
  steps: number
  usage: FleetUsage
  /** The tool currently running, if any. */
  tool?: string
  parentId?: string
  model?: string
}

/** What the panel knows about the project's persistent memory (MEMORY.md index). */
export type FleetMemory = {
  entries: string[]
  path?: string
  readAt: number
}

/** Cumulative cost of the machine's other sessions over the current week and month. */
export type FleetPeriods = {
  week: number
  month: number
  /** Sessions of the period whose cost could neither be read nor estimated. */
  unpriced: number
  /** Sessions of the period whose cost is estimated from their tokens (no `cost-state` line). */
  estimated: number
  /** What the same tokens would have cost on the comparison model (see `compareUsd`). */
  compareWeek: number
  compareMonth: number
  scannedAt: number
}

/** The figures the HUD displays. */
export type Figures = {
  contextPercent?: number
  sessionUsd?: number
  sessionEstimated?: boolean
  weekUsd?: number
  monthUsd?: number
  periodsEstimated?: number
  unpriced?: number
  fiveHourPercent?: number
  sevenDayPercent?: number
  /** Set when the comparison row is shown: the comparison model's label and the equivalent costs. */
  compareLabel?: string
  compareSessionUsd?: number
  compareWeekUsd?: number
  compareMonthUsd?: number
}

/** Everything the panel draws, computed by the monitor on every change. */
export type FleetSnapshot = {
  loops: FleetLoop[]
  memory: FleetMemory
  figures: Figures
  sessionId?: string
  project?: string
}

export const MAIN = 'main'

export function emptyUsage(): FleetUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 }
}

export function addUsage(a: FleetUsage, b: FleetUsage): FleetUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
  }
}

export function totalTokens(usage: FleetUsage) {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite
}

export function isOver(status: FleetStatus) {
  return status === 'completed' || status === 'failed' || status === 'killed'
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
