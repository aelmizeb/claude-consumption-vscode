#!/usr/bin/env node
/**
 * Status line bridge for the Claude Consumption extension.
 *
 * Claude Code runs this command on every refresh of its status line and pipes a JSON document to its
 * standard input (model, context, cost, subscription quota…). The script keeps the essentials in
 * <config>/claude-consumption/status.json, which the panel reads, then prints a sober status line.
 *
 * Install it with the "Claude Consumption: Install the Status Line Bridge" command, or by hand in
 * ~/.claude/settings.json:
 *   "statusLine": { "type": "command", "command": "node \"<extension folder>/bridge/statusline.js\"" }
 */
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => (input += chunk))
process.stdin.on('end', () => {
  let data = {}

  try {
    data = JSON.parse(input)
  } catch {
    // Empty or truncated input: write what we can.
  }

  const root = (process.env.CLAUDE_CONFIG_DIR || '').trim() || path.join(os.homedir(), '.claude')
  const dir = path.join(root, 'claude-consumption')
  const status = {
    at: Date.now(),
    session_id: data.session_id,
    model: data.model,
    context_window: data.context_window,
    rate_limits: data.rate_limits,
    cost: data.cost,
  }

  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(status))
  } catch {
    // Directory not writable: the status line still shows.
  }

  const parts = []
  const model = data.model && (data.model.display_name || data.model.id)
  const context = data.context_window && data.context_window.used_percentage
  const cost = data.cost && data.cost.total_cost_usd
  const limits = data.rate_limits || {}
  const five = limits.five_hour && limits.five_hour.used_percentage
  const seven = limits.seven_day && limits.seven_day.used_percentage

  if (model) parts.push(String(model))
  if (typeof context === 'number') parts.push(`ctx ${Math.round(context)}%`)
  if (typeof cost === 'number') parts.push(`$${cost.toFixed(2)}`)
  if (typeof five === 'number' || typeof seven === 'number') {
    parts.push(`quota ${typeof five === 'number' ? Math.round(five) + '%' : '--'} / ${typeof seven === 'number' ? Math.round(seven) + '%' : '--'}`)
  }

  process.stdout.write(parts.join(' · '))
})
