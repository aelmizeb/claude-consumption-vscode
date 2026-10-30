import * as path from 'node:path'
import * as readline from 'node:readline'
import { createReadStream, promises as fs } from 'node:fs'
import { compareUsd, estimateByModel } from './pricing'
import { toUsage } from './tracker'
import { FleetPeriods, FleetUsage, addUsage, emptyUsage, isRecord } from './types'

/** What the last read of a transcript gave, so it is not read again while unchanged. */
export type TranscriptCacheEntry = { size: number; mtimeMs: number; usd: number | null; estimated: boolean; usage: FleetUsage }
export type TranscriptCache = Record<string, TranscriptCacheEntry>

/** What a transcript is worth: its cost, whether it is only an estimate, and its tokens (sub-agents included). */
export type TranscriptCost = { usd: number | null; estimated: boolean; usage: FleetUsage }

const COST_STATE_MARK = '"type":"cost-state"'
const ASSISTANT_MARK = '"type":"assistant"'

/** Start of the week (Monday 00:00, local time) and of the current month, in ms. */
export function periodStarts(now: number) {
  const date = new Date(now)
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - ((date.getDay() + 6) % 7))
  const first = new Date(date.getFullYear(), date.getMonth(), 1)

  return { week: monday.getTime(), month: first.getTime() }
}

function addTo(map: Record<string, FleetUsage>, model: string, usage: FleetUsage) {
  map[model] = addUsage(map[model] ?? emptyUsage(), usage)
}

/**
 * Streams one transcript file: every request (deduplicated by `message.id`) goes to `total` and `since`,
 * and every `cost-state` line resets `since` and returns the cost it carries.
 */
async function streamUsage(file: string, total: Record<string, FleetUsage>, since: Record<string, FleetUsage>, trackCost: boolean): Promise<number | undefined> {
  const stream = createReadStream(file, { encoding: 'utf8' })
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity })
  let costState: number | undefined
  let current: { id: string; usage: FleetUsage; model: string } | undefined

  const commit = () => {
    if (!current) return

    addTo(total, current.model, current.usage)
    addTo(since, current.model, current.usage)
    current = undefined
  }

  try {
    for await (const line of lines) {
      if (trackCost && line.includes(COST_STATE_MARK)) {
        try {
          const parsed: unknown = JSON.parse(line)

          if (isRecord(parsed) && parsed.type === 'cost-state' && typeof parsed.totalCostUSD === 'number') {
            // The request in progress was written before this line: it is part of the cost, not of `since`.
            if (current) addTo(total, current.model, current.usage)
            current = undefined
            costState = parsed.totalCostUSD
            for (const key of Object.keys(since)) delete since[key]
          }
        } catch {
          // Truncated line: keep going.
        }
      } else if (line.includes(ASSISTANT_MARK) && line.includes('"usage"')) {
        try {
          const parsed: unknown = JSON.parse(line)

          if (!isRecord(parsed) || parsed.type !== 'assistant' || !isRecord(parsed.message)) continue

          const message = parsed.message

          if (typeof message.id !== 'string' || !isRecord(message.usage)) continue

          if (current && current.id !== message.id) commit()

          current = { id: message.id, usage: toUsage(message.usage), model: typeof message.model === 'string' ? message.model : 'unknown' }
        } catch {
          // Truncated line: keep going.
        }
      }
    }
  } finally {
    lines.close()
    stream.destroy()
  }

  commit()

  return costState
}

/**
 * The cost of a transcript: its last `cost-state` line plus an estimate of the requests written after it,
 * or an estimate of all its requests (sub-agents included) from the price list. `usd` is `null` when
 * nothing could be priced. `usage` always sums every request of the session and of its sub-agents.
 */
export async function readTranscriptCost(file: string): Promise<TranscriptCost> {
  const total: Record<string, FleetUsage> = {}
  const since: Record<string, FleetUsage> = {}
  const costState = await streamUsage(file, total, since, true)
  const subagents = path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents')
  let names: string[] = []

  try {
    names = (await fs.readdir(subagents)).filter(name => /^agent-.+\.jsonl$/.test(name))
  } catch {
    // No sub-agents.
  }

  for (const name of names) {
    const scratch: Record<string, FleetUsage> = {}

    try {
      await streamUsage(path.join(subagents, name), total, scratch, false)
    } catch {
      // Unreadable sub-agent transcript: its tokens are left out.
    }
  }

  let usage = emptyUsage()

  for (const one of Object.values(total)) usage = addUsage(usage, one)

  const estimate = estimateByModel(costState === undefined ? total : since)

  if (costState !== undefined) return { usd: costState + estimate.usd, estimated: false, usage }
  if (!estimate.priced) return { usd: null, estimated: true, usage }

  return { usd: estimate.usd, estimated: true, usage }
}

export type ScanResult = { periods: FleetPeriods; cache: TranscriptCache; failed: string[] }

/**
 * Collects the cost of every session on the machine active since the start of the week or month, from
 * the transcripts (<config>/projects/<project>/<session>.jsonl), except the sessions followed live
 * (`exclude`), whose cost is read at draw time. A session counts in the period of its last activity.
 * Files unchanged since the last scan are not read again.
 */
export async function scanPeriodCosts(root: string, exclude: ReadonlySet<string>, cache: TranscriptCache, now: number): Promise<ScanResult> {
  const starts = periodStarts(now)
  const cutoff = Math.min(starts.week, starts.month)
  const projects = path.join(root, 'projects')
  const next: TranscriptCache = {}
  const failed: string[] = []
  const periods: FleetPeriods = { week: 0, month: 0, unpriced: 0, estimated: 0, compareWeek: 0, compareMonth: 0, scannedAt: now }
  let names: string[] = []

  try {
    names = (await fs.readdir(projects, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch {
    return { periods, cache: next, failed: [`${projects} unreadable`] }
  }

  for (const name of names) {
    const dir = path.join(projects, name)
    let files: string[]

    try {
      files = (await fs.readdir(dir)).filter(file => file.endsWith('.jsonl'))
    } catch {
      continue
    }

    for (const file of files) {
      const sessionId = file.slice(0, -'.jsonl'.length)

      if (exclude.has(sessionId)) continue

      const full = path.join(dir, file)
      let stat

      try {
        stat = await fs.stat(full)
      } catch {
        continue
      }

      if (stat.mtimeMs < cutoff) continue

      const known = cache[full]
      let entry: TranscriptCacheEntry

      if (known && known.usage && known.size === stat.size && known.mtimeMs === stat.mtimeMs) {
        entry = known
      } else {
        try {
          const read = await readTranscriptCost(full)
          entry = { size: stat.size, mtimeMs: stat.mtimeMs, usd: read.usd, estimated: read.estimated, usage: read.usage }
        } catch (error) {
          failed.push(`${file}: ${error instanceof Error ? error.message : String(error)}`)
          periods.unpriced += 1
          continue
        }
      }

      next[full] = entry
      const compare = compareUsd(entry.usage)

      if (stat.mtimeMs >= starts.week) periods.compareWeek += compare
      if (stat.mtimeMs >= starts.month) periods.compareMonth += compare

      if (entry.usd === null) {
        periods.unpriced += 1
        continue
      }

      if (entry.estimated) periods.estimated += 1
      if (stat.mtimeMs >= starts.week) periods.week += entry.usd
      if (stat.mtimeMs >= starts.month) periods.month += entry.usd
    }
  }

  return { periods, cache: next, failed }
}
