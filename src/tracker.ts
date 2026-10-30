import { estimateByModel } from './pricing'
import { FleetStatus, FleetUsage, addUsage, emptyUsage, isRecord } from './types'

/** What a transcript says about a sub-agent this loop spawned (`Agent` tool). */
export type SpawnInfo = { description: string; type: string; startedAt: number; model?: string }

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** The tokens of one request, as an `assistant` line carries them in `message.usage`. */
export function toUsage(raw: unknown): FleetUsage {
  if (!isRecord(raw)) return emptyUsage()

  const creation = isRecord(raw.cache_creation) ? raw.cache_creation : {}

  return {
    input: num(raw.input_tokens),
    output: num(raw.output_tokens),
    cacheRead: num(raw.cache_read_input_tokens),
    cacheWrite: num(raw.cache_creation_input_tokens),
    cacheWrite1h: num(creation.ephemeral_1h_input_tokens),
  }
}

function addTo(map: Record<string, FleetUsage>, model: string, usage: FleetUsage) {
  map[model] = addUsage(map[model] ?? emptyUsage(), usage)
}

/**
 * Follows one loop (the main conversation or a sub-agent) line by line through its transcript: tokens
 * per request (a request is written as several lines, one per content block, that repeat the same
 * `message.id` and `usage`), current tool, last context size, cost written by Claude Code.
 */
export class LoopTracker {
  steps = 0
  model?: string
  tool?: string
  status: FleetStatus = 'idle'
  /** Tokens of the last request: what the context window holds. */
  contextTokens = 0
  startedAt = 0
  lastEventAt = 0
  /** The last `totalCostUSD` Claude Code wrote in a `cost-state` line. */
  costUsd?: number
  /** The loop produced a final answer (`stop_reason: end_turn`). */
  sawEndTurn = false
  /** The sub-agents this loop spawned, by id. */
  agents = new Map<string, SpawnInfo>()

  private committed: Record<string, FleetUsage> = {}
  private sinceCost: Record<string, FleetUsage> = {}
  private current?: { id: string; usage: FleetUsage; model: string; counted: boolean }
  private pending = new Map<string, string>()
  private spawns = new Map<string, { description: string; type: string; model?: string }>()

  /** Tokens of the whole loop, last request included. */
  get usage(): FleetUsage {
    let total = emptyUsage()

    for (const usage of Object.values(this.committed)) total = addUsage(total, usage)
    if (this.current) total = addUsage(total, this.current.usage)

    return total
  }

  get usageByModel(): Record<string, FleetUsage> {
    const out: Record<string, FleetUsage> = {}

    for (const [model, usage] of Object.entries(this.committed)) addTo(out, model, usage)
    if (this.current) addTo(out, this.current.model, this.current.usage)

    return out
  }

  /**
   * The loop's cost in dollars: the last `cost-state` plus an estimate of what followed, or an estimate
   * of everything from the price list when Claude Code wrote nothing. `estimated` says the total rests
   * entirely on the estimate.
   */
  cost(): { usd?: number; estimated: boolean } {
    const since: Record<string, FleetUsage> = {}

    for (const [model, usage] of Object.entries(this.costUsd === undefined ? this.committed : this.sinceCost)) addTo(since, model, usage)
    if (this.current && (this.costUsd === undefined || !this.current.counted)) addTo(since, this.current.model, this.current.usage)

    const estimate = estimateByModel(since)

    if (this.costUsd !== undefined) return { usd: this.costUsd + estimate.usd, estimated: false }
    if (!estimate.priced) return { usd: undefined, estimated: true }

    return { usd: estimate.usd, estimated: true }
  }

  apply(line: string) {
    let parsed: unknown

    try {
      parsed = JSON.parse(line)
    } catch {
      return
    }

    if (!isRecord(parsed)) return

    const at = typeof parsed.timestamp === 'string' ? Date.parse(parsed.timestamp) : NaN

    if (Number.isFinite(at)) {
      if (!this.startedAt) this.startedAt = at
      if (at > this.lastEventAt) this.lastEventAt = at
    }

    switch (parsed.type) {
      case 'assistant':
        this.assistant(parsed)
        break
      case 'user':
        this.user(parsed, Number.isFinite(at) ? at : this.lastEventAt)
        break
      case 'cost-state':
        if (typeof parsed.totalCostUSD === 'number') {
          this.costUsd = parsed.totalCostUSD
          this.sinceCost = {}
          if (this.current) this.current.counted = true
        }
        break
      case 'system':
        if (parsed.subtype === 'compact_boundary' && isRecord(parsed.compactMetadata) && typeof parsed.compactMetadata.postTokens === 'number') {
          this.contextTokens = parsed.compactMetadata.postTokens
        }
        break
      default:
        break
    }
  }

  private assistant(line: Record<string, unknown>) {
    const message = isRecord(line.message) ? line.message : undefined

    if (!message) return

    if (isRecord(message.usage) && typeof message.id === 'string') {
      const usage = toUsage(message.usage)
      const model = typeof message.model === 'string' ? message.model : typeof line.requestedModel === 'string' ? line.requestedModel : 'unknown'
      const sameMessage = this.current?.id === message.id

      if (this.current && !sameMessage) this.commit()
      if (!sameMessage) this.steps += 1

      this.current = { id: message.id, usage, model, counted: sameMessage && this.current ? this.current.counted : false }
      this.model = model
      this.contextTokens = usage.input + usage.cacheRead + usage.cacheWrite
    }

    const content = Array.isArray(message.content) ? message.content : []

    for (const block of content) {
      if (!isRecord(block) || block.type !== 'tool_use' || typeof block.id !== 'string') continue

      const name = typeof block.name === 'string' ? block.name : 'tool'
      this.pending.set(block.id, name)
      this.tool = name

      if (name === 'Agent' && isRecord(block.input)) {
        this.spawns.set(block.id, {
          description: typeof block.input.description === 'string' ? block.input.description : '',
          type: typeof block.input.subagent_type === 'string' ? block.input.subagent_type : 'agent',
          model: typeof block.input.model === 'string' ? block.input.model : undefined,
        })
      }
    }

    this.status = 'running'

    if (message.stop_reason === 'end_turn') {
      this.status = 'idle'
      this.tool = undefined
      this.sawEndTurn = true
      this.pending.clear()
    }
  }

  private user(line: Record<string, unknown>, at: number) {
    const message = isRecord(line.message) ? line.message : undefined
    const content = message && Array.isArray(message.content) ? message.content : []
    let resultFor: string | undefined

    for (const block of content) {
      if (!isRecord(block) || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue

      this.pending.delete(block.tool_use_id)
      resultFor = block.tool_use_id
    }

    const result = isRecord(line.toolUseResult) ? line.toolUseResult : undefined

    if (result && typeof result.agentId === 'string') {
      const spawn = resultFor ? this.spawns.get(resultFor) : undefined

      this.agents.set(result.agentId, {
        description: typeof result.description === 'string' ? result.description : (spawn?.description ?? ''),
        type: spawn?.type ?? 'agent',
        startedAt: at,
        model: typeof result.resolvedModel === 'string' ? result.resolvedModel : spawn?.model,
      })
    }

    const next = this.pending.values().next()
    this.tool = next.done ? undefined : next.value
    // After a user message (prompt or tool result), the model is called again.
    this.status = 'running'
    this.sawEndTurn = false
  }

  private commit() {
    if (!this.current) return

    addTo(this.committed, this.current.model, this.current.usage)
    if (!this.current.counted) addTo(this.sinceCost, this.current.model, this.current.usage)
    this.current = undefined
  }
}
