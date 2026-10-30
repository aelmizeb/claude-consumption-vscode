import { promises as fs } from 'node:fs'
import { isRecord } from './types'

/** What the status line bridge (bridge/statusline.js) writes: an extract of the JSON Claude Code gives it. */
export type BridgeStatus = {
  at: number
  sessionId?: string
  fiveHourPercent?: number
  sevenDayPercent?: number
  contextPercent?: number
  contextWindow?: number
  costUsd?: number
}

const FRESH_MS = 15 * 60_000

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Reads the bridge file when it exists and is less than fifteen minutes old. */
export async function readBridgeStatus(file: string, now: number): Promise<BridgeStatus | undefined> {
  try {
    const stat = await fs.stat(file)

    if (now - stat.mtimeMs > FRESH_MS) return undefined

    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'))

    if (!isRecord(parsed)) return undefined

    const limits = isRecord(parsed.rate_limits) ? parsed.rate_limits : {}
    const five = isRecord(limits.five_hour) ? limits.five_hour : {}
    const seven = isRecord(limits.seven_day) ? limits.seven_day : {}
    const context = isRecord(parsed.context_window) ? parsed.context_window : {}
    const cost = isRecord(parsed.cost) ? parsed.cost : {}

    return {
      at: stat.mtimeMs,
      sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : undefined,
      fiveHourPercent: num(five.used_percentage),
      sevenDayPercent: num(seven.used_percentage),
      contextPercent: num(context.used_percentage),
      contextWindow: num(context.context_window_size),
      costUsd: num(cost.total_cost_usd),
    }
  } catch {
    return undefined
  }
}
