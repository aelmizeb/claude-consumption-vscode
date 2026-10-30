import * as path from 'node:path'
import * as vscode from 'vscode'
import { promises as fs } from 'node:fs'
import { Monitor } from './monitor'
import { FleetViewProvider } from './panel'
import { configDir } from './paths'
import { isRecord } from './types'

const CLAUDE_EXTENSION = 'anthropic.claude-code'
const VIEW_OWN = 'claudeConsumption.fleet'
const VIEW_IN_CLAUDE = 'claudeConsumption.fleetInClaude'

/** Where the panel goes: below the Claude Code chat when the extension is there and the setting asks for it. */
function dock(): 'claude' | 'own' {
  const wanted = vscode.workspace.getConfiguration('claudeConsumption').get<string>('dock') ?? 'claude'

  return wanted === 'claude' && vscode.extensions.getExtension(CLAUDE_EXTENSION) ? 'claude' : 'own'
}

function applyDock() {
  void vscode.commands.executeCommand('setContext', 'claudeConsumption.dock', dock())
}

export function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel('Claude Consumption')
  const provider = new FleetViewProvider(context.extensionUri)
  const monitor = new Monitor(context, log, snapshot => provider.update(snapshot))

  applyDock()

  context.subscriptions.push(
    log,
    monitor,
    vscode.window.registerWebviewViewProvider(VIEW_OWN, provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerWebviewViewProvider(VIEW_IN_CLAUDE, provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.extensions.onDidChange(applyDock),
    vscode.workspace.onDidChangeWorkspaceFolders(() => monitor.restart()),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('claudeConsumption')) return

      applyDock()
      monitor.restart()
    }),
    vscode.commands.registerCommand('claudeConsumption.open', () => vscode.commands.executeCommand(`${dock() === 'claude' ? VIEW_IN_CLAUDE : VIEW_OWN}.focus`)),
    vscode.commands.registerCommand('claudeConsumption.refresh', () => monitor.refresh()),
    vscode.commands.registerCommand('claudeConsumption.rescanCosts', () => monitor.rescanCosts()),
    vscode.commands.registerCommand('claudeConsumption.showLog', () => log.show()),
    vscode.commands.registerCommand('claudeConsumption.installStatusLine', () => installStatusLine(context)),
  )

  monitor.start()
}

export function deactivate() {}

/**
 * Wires the status line bridge into Claude Code's settings.json: on every refresh of its status line,
 * Claude Code runs the script, which writes the 5h / 7d quota and the context for the panel.
 */
async function installStatusLine(context: vscode.ExtensionContext) {
  const root = configDir(vscode.workspace.getConfiguration('claudeConsumption').get<string>('configDir'))
  const settingsFile = path.join(root, 'settings.json')
  const script = path.join(context.extensionPath, 'bridge', 'statusline.js').split(path.sep).join('/')
  const command = `node "${script}"`
  let settings: Record<string, unknown> = {}

  try {
    const parsed: unknown = JSON.parse(await fs.readFile(settingsFile, 'utf8'))

    if (isRecord(parsed)) settings = parsed
  } catch {
    // No settings.json yet: it will be created.
  }

  if (settings.statusLine !== undefined) {
    const existing = JSON.stringify(settings.statusLine)

    if (existing.includes('statusline.js')) {
      void vscode.window.showInformationMessage('The status line bridge is already installed.')

      return
    }

    const choice = await vscode.window.showWarningMessage(
      `settings.json already has a status line (${existing.slice(0, 80)}). Replace it with the bridge? Your current command will be lost; to keep it, chain it yourself after ${command}.`,
      { modal: true },
      'Replace',
    )

    if (choice !== 'Replace') return
  } else {
    const choice = await vscode.window.showInformationMessage(
      `Add the status line "${command}" to ${settingsFile}? Claude Code will run it on every refresh and the panel will show the 5h / 7d quota.`,
      { modal: true },
      'Install',
    )

    if (choice !== 'Install') return
  }

  settings.statusLine = { type: 'command', command }
  await fs.mkdir(root, { recursive: true })
  await fs.writeFile(settingsFile, JSON.stringify(settings, null, 2) + '\n', 'utf8')
  void vscode.window.showInformationMessage('Bridge installed: the quota will appear in the panel after the next turn of a Claude Code session.')
}
