import * as path from 'node:path'
import { promises as fs } from 'node:fs'
import { LineReader } from './reader'
import { LoopTracker } from './tracker'
import { FleetLoop, FleetStatus, FleetUsage, MAIN, addUsage, emptyUsage, isRecord } from './types'

type AgentMeta = { agentType?: string; description?: string; finished?: boolean }

type AgentEntry = { tracker: LoopTracker; reader: LineReader; meta: AgentMeta; metaMtime: number; mtimeMs: number }

/** Reads `agent-<id>.meta.json` (type, description, completion). */
async function readMeta(file: string): Promise<AgentMeta> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'))

    if (!isRecord(parsed)) return {}

    return {
      agentType: typeof parsed.agentType === 'string' ? parsed.agentType : undefined,
      description: typeof parsed.description === 'string' ? parsed.description : undefined,
      finished: parsed.finished === true,
    }
  } catch {
    return {}
  }
}

/**
 * A Claude Code session followed live: its transcript (`<project>/<id>.jsonl`) and those of its
 * sub-agents (`<project>/<id>/subagents/agent-*.jsonl`). Sub-agent lines written in the main transcript
 * (older versions: `isSidechain` and `agentId`) are routed to the agent's loop.
 */
export class Session {
  readonly main = new LoopTracker()
  readonly agents = new Map<string, AgentEntry>()
  mtimeMs = 0
  private readonly reader: LineReader
  private readonly dir: string

  constructor(readonly id: string, readonly file: string, readonly project: string) {
    this.reader = new LineReader(file)
    this.dir = path.join(path.dirname(file), id)
  }

  async refresh(): Promise<boolean> {
    let changed = false

    try {
      const stat = await fs.stat(this.file)
      this.mtimeMs = Math.max(this.mtimeMs, stat.mtimeMs)
    } catch {
      return false
    }

    const read = await this.reader.read(line => this.route(line))

    if (read > 0) changed = true
    if (await this.refreshAgents()) changed = true

    return changed
  }

  private route(line: string) {
    // Sub-agent lines are recognizable by their `agentId`: a textual check before parsing.
    if (line.includes('"isSidechain":true') && line.includes('"agentId":"')) {
      const id = /"agentId":"([^"]+)"/.exec(line)?.[1]

      if (id) {
        this.agent(id).tracker.apply(line)

        return
      }
    }

    this.main.apply(line)
  }

  private agent(id: string): AgentEntry {
    let entry = this.agents.get(id)

    if (!entry) {
      entry = {
        tracker: new LoopTracker(),
        reader: new LineReader(path.join(this.dir, 'subagents', `agent-${id}.jsonl`)),
        meta: {},
        metaMtime: 0,
        mtimeMs: 0,
      }
      this.agents.set(id, entry)
    }

    return entry
  }

  private async refreshAgents(): Promise<boolean> {
    const dir = path.join(this.dir, 'subagents')
    let names: string[]
    let changed = false

    try {
      names = await fs.readdir(dir)
    } catch {
      return false
    }

    for (const name of names) {
      const match = /^agent-(.+)\.jsonl$/.exec(name)

      if (!match || !match[1]) continue

      const id = match[1]
      const entry = this.agent(id)
      const file = path.join(dir, name)

      try {
        const stat = await fs.stat(file)

        if (stat.mtimeMs !== entry.mtimeMs) {
          entry.mtimeMs = stat.mtimeMs
          if ((await entry.reader.read(line => entry.tracker.apply(line))) > 0) changed = true
        }
      } catch {
        continue
      }

      try {
        const metaFile = path.join(dir, `agent-${id}.meta.json`)
        const stat = await fs.stat(metaFile)

        if (stat.mtimeMs !== entry.metaMtime) {
          entry.metaMtime = stat.mtimeMs
          entry.meta = await readMeta(metaFile)
          changed = true
        }
      } catch {
        // No meta file: the main transcript (Agent tool) provides the type and description.
      }
    }

    return changed
  }

  /** The tokens of the whole session: the main loop and every sub-agent. */
  totalUsage(): FleetUsage {
    let total = this.main.usage

    for (const entry of this.agents.values()) total = addUsage(total, entry.tracker.usage)

    return total
  }

  /** The session's loops as the panel draws them, the main one first. */
  loops(now: number, idleAfterMs: number): FleetLoop[] {
    const stale = now - this.mtimeMs > idleAfterMs
    const main = this.main
    const mainStatus: FleetStatus = main.status === 'running' && stale ? 'idle' : main.status
    const first: FleetLoop = {
      id: MAIN,
      type: MAIN,
      description: '',
      status: mainStatus,
      startedAt: main.startedAt,
      steps: main.steps,
      usage: main.usage,
      tool: mainStatus === 'running' ? main.tool : undefined,
      model: main.model,
    }
    const rest: FleetLoop[] = []

    for (const [id, entry] of this.agents) {
      const tracker = entry.tracker
      const spawn = main.agents.get(id)
      const agentStale = now - Math.max(entry.mtimeMs, tracker.lastEventAt) > idleAfterMs
      let status: FleetStatus

      // Finished according to Claude Code or after a final answer: done; silent for too long without that: stopped.
      if (entry.meta.finished || tracker.sawEndTurn) status = 'completed'
      else if (agentStale) status = 'killed'
      else status = tracker.status === 'idle' ? 'running' : tracker.status

      if (!tracker.startedAt && !spawn) continue

      rest.push({
        id,
        type: entry.meta.agentType ?? spawn?.type ?? 'agent',
        description: entry.meta.description ?? spawn?.description ?? '',
        status,
        startedAt: tracker.startedAt || spawn?.startedAt || entry.mtimeMs,
        endedAt: status === 'completed' || status === 'killed' ? tracker.lastEventAt || entry.mtimeMs : undefined,
        steps: tracker.steps,
        usage: tracker.usage,
        tool: status === 'running' ? tracker.tool : undefined,
        parentId: MAIN,
        model: tracker.model ?? spawn?.model,
      })
    }

    // Sub-agents the main transcript knows but that have no file yet: they just took off.
    for (const [id, spawn] of main.agents) {
      if (this.agents.has(id)) continue

      rest.push({
        id,
        type: spawn.type,
        description: spawn.description,
        status: now - spawn.startedAt > idleAfterMs ? 'completed' : 'pending',
        startedAt: spawn.startedAt,
        steps: 0,
        usage: emptyUsage(),
        parentId: MAIN,
        model: spawn.model,
      })
    }

    return [first, ...rest.sort((a, b) => a.startedAt - b.startedAt)]
  }
}
