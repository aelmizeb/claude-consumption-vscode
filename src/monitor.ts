import * as path from 'node:path'
import * as vscode from 'vscode'
import { promises as fs } from 'node:fs'
import { TranscriptCache, scanPeriodCosts } from './costs'
import { readMemory } from './memory'
import { configDir, projectDirs } from './paths'
import { COMPARE_LABEL, compareUsd, contextWindowFor } from './pricing'
import { Session } from './session'
import { BridgeStatus, readBridgeStatus } from './status'
import { Figures, FleetMemory, FleetPeriods, FleetSnapshot, isRecord } from './types'

// The suffix changes when the cache's shape changes: entries from an older version are ignored.
const CACHE_KEY = 'claudeConsumption.transcriptCache-2'
const EMPTY_PERIODS: FleetPeriods = { week: 0, month: 0, unpriced: 0, estimated: 0, compareWeek: 0, compareMonth: 0, scannedAt: 0 }

type Candidate = { id: string; file: string; project: string; mtimeMs: number }

/**
 * The monitor: it follows the most recently active Claude Code session of the relevant projects, re-reads
 * its transcripts at a regular interval, reads the project's memory, collects the other sessions' costs
 * and publishes a snapshot on every change.
 */
export class Monitor implements vscode.Disposable {
  private timer?: ReturnType<typeof setInterval>
  private memoryTimer?: ReturnType<typeof setInterval>
  private costTimer?: ReturnType<typeof setInterval>
  private session?: Session
  private memory: FleetMemory = { entries: [], readAt: 0 }
  private periods: FleetPeriods = EMPTY_PERIODS
  private bridge?: BridgeStatus
  private settingsModel?: string
  private lastJson = ''
  private ticking = false
  private scanning = false
  private dirsAt = 0
  private dirs: string[] = []

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.OutputChannel,
    private readonly publish: (snapshot: FleetSnapshot) => void,
  ) {}

  get root(): string {
    return configDir(vscode.workspace.getConfiguration('claudeConsumption').get<string>('configDir'))
  }

  get statusFile(): string {
    const custom = (vscode.workspace.getConfiguration('claudeConsumption').get<string>('statusFile') ?? '').trim()

    return custom || path.join(this.root, 'claude-consumption', 'status.json')
  }

  private get folders(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath)
  }

  start() {
    this.stop()
    const config = vscode.workspace.getConfiguration('claudeConsumption')
    const poll = Math.max(1, config.get<number>('pollSeconds') ?? 2) * 1000

    this.log.appendLine(`Configuration directory: ${this.root}`)
    void this.readSettingsModel()
    void this.refreshMemory()
    void this.rescanCosts()
    void this.tick()
    this.timer = setInterval(() => void this.tick(), poll)
    this.memoryTimer = setInterval(() => void this.refreshMemory(), 60_000)
    this.costTimer = setInterval(() => void this.rescanCosts(), 5 * 60_000)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    if (this.memoryTimer) clearInterval(this.memoryTimer)
    if (this.costTimer) clearInterval(this.costTimer)
    this.timer = this.memoryTimer = this.costTimer = undefined
  }

  /** Settings or workspace folders changed: start over. */
  restart() {
    this.session = undefined
    this.dirsAt = 0
    this.lastJson = ''
    this.start()
  }

  dispose() {
    this.stop()
  }

  async refresh() {
    this.lastJson = ''
    await this.refreshMemory()
    await this.tick()
  }

  private async readSettingsModel() {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(path.join(this.root, 'settings.json'), 'utf8'))
      this.settingsModel = isRecord(parsed) && typeof parsed.model === 'string' ? parsed.model : undefined
    } catch {
      this.settingsModel = undefined
    }
  }

  private async refreshMemory() {
    try {
      this.memory = await readMemory(this.root, this.folders, Date.now())
    } catch (error) {
      this.log.appendLine(`Memory unreadable: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async rescanCosts() {
    if (this.scanning) return

    this.scanning = true

    try {
      const stored = this.context.globalState.get<TranscriptCache>(CACHE_KEY) ?? {}
      const exclude = new Set(this.session ? [this.session.id] : [])
      const started = Date.now()
      const result = await scanPeriodCosts(this.root, exclude, stored, started)

      this.periods = result.periods
      await this.context.globalState.update(CACHE_KEY, result.cache)
      this.log.appendLine(
        `Cost scan in ${Date.now() - started} ms: week $${result.periods.week.toFixed(2)}, month $${result.periods.month.toFixed(2)}` +
          ` (${result.periods.estimated} estimated, ${result.periods.unpriced} unpriced)${result.failed.length ? '; failures: ' + result.failed.slice(0, 5).join(' | ') : ''}`,
      )
      this.lastJson = ''
      await this.tick()
    } catch (error) {
      this.log.appendLine(`Cost scan failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.scanning = false
    }
  }

  private async projectDirs(now: number): Promise<string[]> {
    if (now - this.dirsAt < 30_000) return this.dirs

    const all = vscode.workspace.getConfiguration('claudeConsumption').get<string>('scope') === 'all'
    this.dirs = await projectDirs(this.root, this.folders, all)
    this.dirsAt = now

    return this.dirs
  }

  /** The most recently active session among the followed projects. */
  private async newest(now: number): Promise<Candidate | undefined> {
    let best: Candidate | undefined

    for (const dir of await this.projectDirs(now)) {
      let names: string[]

      try {
        names = await fs.readdir(dir)
      } catch {
        continue
      }

      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue

        const file = path.join(dir, name)

        try {
          const stat = await fs.stat(file)

          if (!best || stat.mtimeMs > best.mtimeMs) best = { id: name.slice(0, -'.jsonl'.length), file, project: path.basename(dir), mtimeMs: stat.mtimeMs }
        } catch {
          continue
        }
      }
    }

    return best
  }

  private async tick() {
    if (this.ticking) return

    this.ticking = true

    try {
      const now = Date.now()
      const candidate = await this.newest(now)

      if (candidate && (!this.session || this.session.id !== candidate.id)) {
        this.log.appendLine(`Following session ${candidate.id} (${candidate.project})`)
        this.session = new Session(candidate.id, candidate.file, candidate.project)
      }

      if (this.session) await this.session.refresh()

      this.bridge = await readBridgeStatus(this.statusFile, now)
      const snapshot = this.snapshot(now)
      const json = JSON.stringify(snapshot)

      if (json !== this.lastJson) {
        this.lastJson = json
        this.publish(snapshot)
      }
    } catch (error) {
      this.log.appendLine(`Read failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.ticking = false
    }
  }

  private snapshot(now: number): FleetSnapshot {
    const config = vscode.workspace.getConfiguration('claudeConsumption')
    const idleAfterMs = Math.max(30, config.get<number>('idleAfterSeconds') ?? 600) * 1000
    const session = this.session
    const loops = session ? session.loops(now, idleAfterMs) : []
    const main = session?.main
    const cost = main?.cost()
    // The bridge only speaks for the current session when it was written by it.
    const bridge = this.bridge && (!this.bridge.sessionId || !session || this.bridge.sessionId === session.id) ? this.bridge : undefined
    const forced = config.get<number>('contextWindow') ?? 0
    const window = forced > 0 ? forced : (bridge?.contextWindow ?? contextWindowFor(main?.model, this.settingsModel))
    const contextPercent = bridge?.contextPercent ?? (main && main.contextTokens > 0 ? Math.min(100, (main.contextTokens / window) * 100) : undefined)
    const sessionUsd = cost?.usd
    const scanned = this.periods.scannedAt > 0
    const figures: Figures = {
      contextPercent,
      sessionUsd,
      sessionEstimated: cost?.estimated,
      weekUsd: scanned ? this.periods.week + (sessionUsd ?? 0) : undefined,
      monthUsd: scanned ? this.periods.month + (sessionUsd ?? 0) : undefined,
      periodsEstimated: this.periods.estimated,
      unpriced: this.periods.unpriced,
      fiveHourPercent: this.bridge?.fiveHourPercent,
      sevenDayPercent: this.bridge?.sevenDayPercent,
    }

    if (config.get<boolean>('compareWithDeepSeek') === true) {
      const sessionCompare = session ? compareUsd(session.totalUsage()) : undefined

      figures.compareLabel = COMPARE_LABEL
      figures.compareSessionUsd = sessionCompare
      figures.compareWeekUsd = scanned ? this.periods.compareWeek + (sessionCompare ?? 0) : undefined
      figures.compareMonthUsd = scanned ? this.periods.compareMonth + (sessionCompare ?? 0) : undefined
    }

    return { loops, memory: this.memory, figures, sessionId: session?.id, project: session?.project }
  }
}
