import assert from 'node:assert/strict'
import * as os from 'node:os'
import * as path from 'node:path'
import { promises as fs } from 'node:fs'
import { test } from 'node:test'
import { periodStarts, readTranscriptCost, scanPeriodCosts } from '../costs'

const line = (object: unknown) => JSON.stringify(object) + '\n'
const assistant = (id: string, output: number) =>
  line({ type: 'assistant', message: { id, model: 'claude-fable-5-1', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 0, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })

test('the week starts on Monday, the month on the first', () => {
  // Wednesday, October 28, 2026 at noon.
  const starts = periodStarts(new Date(2026, 9, 28, 12).getTime())
  assert.equal(new Date(starts.week).getDate(), 26)
  assert.equal(new Date(starts.month).getDate(), 1)
})

test('a transcript is worth its last cost-state plus an estimate of what follows', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-consumption-'))
  const file = path.join(dir, 'a.jsonl')

  await fs.writeFile(file, assistant('m1', 1_000_000) + line({ type: 'cost-state', totalCostUSD: 3 }) + assistant('m2', 1_000_000) + assistant('m2', 1_000_000))
  const read = await readTranscriptCost(file)
  assert.equal(read.estimated, false)
  assert.ok(read.usd !== null && Math.abs(read.usd - 53) < 1e-9, String(read.usd))

  assert.equal(read.usage.output, 2_000_000)

  await fs.writeFile(file, assistant('m1', 1_000_000))
  const estimated = await readTranscriptCost(file)
  assert.equal(estimated.usd, 50)
  assert.equal(estimated.estimated, true)

  await fs.writeFile(file, line({ type: 'user', message: {} }))
  const unpriced = await readTranscriptCost(file)
  assert.equal(unpriced.usd, null)
  assert.equal(unpriced.usage.output, 0)
})

test('sub-agent transcripts count in the tokens, and in the estimate when there is no cost-state', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-consumption-sub-'))
  const file = path.join(dir, 's.jsonl')
  const subagents = path.join(dir, 's', 'subagents')

  await fs.mkdir(subagents, { recursive: true })
  await fs.writeFile(file, assistant('m1', 1_000_000))
  await fs.writeFile(path.join(subagents, 'agent-x.jsonl'), assistant('a1', 1_000_000))

  const read = await readTranscriptCost(file)
  assert.equal(read.usage.output, 2_000_000)
  assert.equal(read.usd, 100)

  // With a cost-state line, the sub-agent is already inside the cost: only its tokens are added.
  await fs.writeFile(file, assistant('m1', 1_000_000) + line({ type: 'cost-state', totalCostUSD: 60 }))
  const priced = await readTranscriptCost(file)
  assert.equal(priced.usd, 60)
  assert.equal(priced.usage.output, 2_000_000)
})

test('the scan sums the sessions of the period, except the one followed live', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-consumption-root-'))
  const project = path.join(root, 'projects', 'c--proj')

  await fs.mkdir(project, { recursive: true })
  await fs.writeFile(path.join(project, 'a.jsonl'), line({ type: 'cost-state', totalCostUSD: 3 }))
  await fs.writeFile(path.join(project, 'b.jsonl'), assistant('m1', 100_000)) // $5 estimated
  await fs.writeFile(path.join(project, 'c.jsonl'), line({ type: 'user', message: {} })) // unpriced
  await fs.writeFile(path.join(project, 'live.jsonl'), line({ type: 'cost-state', totalCostUSD: 999 }))

  const now = Date.now()
  const first = await scanPeriodCosts(root, new Set(['live']), {}, now)
  assert.ok(Math.abs(first.periods.week - 8) < 1e-9, String(first.periods.week))
  assert.ok(Math.abs(first.periods.month - 8) < 1e-9)
  assert.equal(first.periods.unpriced, 1)
  assert.equal(first.periods.estimated, 1)
  assert.equal(Object.keys(first.cache).length, 3)
  // 100k output tokens on deepseek-v4-pro at peak rates: $0.396.
  assert.ok(Math.abs(first.periods.compareMonth - 0.396) < 1e-9, String(first.periods.compareMonth))

  // Second scan: nothing changed, the cache is reused and gives the same total.
  const second = await scanPeriodCosts(root, new Set(['live']), first.cache, now)
  assert.ok(Math.abs(second.periods.month - 8) < 1e-9)
})
