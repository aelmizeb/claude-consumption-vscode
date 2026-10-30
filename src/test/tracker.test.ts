import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LoopTracker } from '../tracker'
import { totalTokens } from '../types'

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0, oneHour = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
  cache_creation: { ephemeral_1h_input_tokens: oneHour, ephemeral_5m_input_tokens: cacheWrite - oneHour },
})

const assistant = (id: string, content: unknown[], u: ReturnType<typeof usage>, stop = 'tool_use', at = '2026-10-28T10:00:00.000Z') =>
  JSON.stringify({ type: 'assistant', timestamp: at, message: { id, model: 'claude-fable-5-1', content, usage: u, stop_reason: stop } })

const user = (content: unknown, extra: Record<string, unknown> = {}, at = '2026-10-28T10:00:01.000Z') =>
  JSON.stringify({ type: 'user', timestamp: at, message: { role: 'user', content }, ...extra })

test('lines that repeat the same message.id count as a single request', () => {
  const tracker = new LoopTracker()

  tracker.apply(user('Hello'))
  tracker.apply(assistant('msg_1', [{ type: 'thinking', thinking: '' }], usage(2, 450, 30516, 18946, 18946)))
  tracker.apply(assistant('msg_1', [{ type: 'text', text: 'ok' }], usage(2, 450, 30516, 18946, 18946)))
  tracker.apply(assistant('msg_1', [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }], usage(2, 450, 30516, 18946, 18946)))

  assert.equal(tracker.steps, 1)
  assert.equal(totalTokens(tracker.usage), 2 + 450 + 30516 + 18946)
  assert.equal(tracker.status, 'running')
  assert.equal(tracker.tool, 'Bash')
  assert.equal(tracker.contextTokens, 2 + 30516 + 18946)
})

test('a tool result releases the tool, end_turn puts the loop to idle', () => {
  const tracker = new LoopTracker()

  tracker.apply(assistant('msg_1', [{ type: 'tool_use', id: 'toolu_1', name: 'Grep', input: {} }], usage(1, 1)))
  tracker.apply(user([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x' }]))
  assert.equal(tracker.tool, undefined)
  assert.equal(tracker.status, 'running')

  tracker.apply(assistant('msg_2', [{ type: 'text', text: 'done' }], usage(1, 1), 'end_turn'))
  assert.equal(tracker.status, 'idle')
  assert.equal(tracker.steps, 2)
  assert.equal(tracker.sawEndTurn, true)
})

test('the Agent tool records the sub-agent with its description and type', () => {
  const tracker = new LoopTracker()

  tracker.apply(assistant('msg_1', [{ type: 'tool_use', id: 'toolu_9', name: 'Agent', input: { description: 'Explore', subagent_type: 'Explore', prompt: '…' } }], usage(1, 1)))
  tracker.apply(user([{ type: 'tool_result', tool_use_id: 'toolu_9', content: 'launched' }], { toolUseResult: { isAsync: true, agentId: 'a1', description: 'Explore', resolvedModel: 'claude-haiku-5-5' } }))

  const spawn = tracker.agents.get('a1')
  if (!spawn) throw new Error('missing sub-agent')
  assert.equal(spawn.type, 'Explore')
  assert.equal(spawn.description, 'Explore')
  assert.equal(spawn.model, 'claude-haiku-5-5')
})

test('the cost follows cost-state then estimates what follows; without cost-state everything is estimated', () => {
  const tracker = new LoopTracker()

  tracker.apply(assistant('msg_1', [{ type: 'text', text: 'a' }], usage(1_000_000, 0)))
  assert.deepEqual(tracker.cost(), { usd: 10, estimated: true })

  tracker.apply(JSON.stringify({ type: 'cost-state', totalCostUSD: 7.5 }))
  assert.deepEqual(tracker.cost(), { usd: 7.5, estimated: false })

  tracker.apply(assistant('msg_2', [{ type: 'text', text: 'b' }], usage(0, 1_000_000)))
  const after = tracker.cost()
  assert.equal(after.estimated, false)
  assert.ok(after.usd !== undefined && Math.abs(after.usd - 57.5) < 1e-9)
})

test('compaction sets the context size', () => {
  const tracker = new LoopTracker()

  tracker.apply(JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { preTokens: 967332, postTokens: 19204 } }))
  assert.equal(tracker.contextTokens, 19204)
})
