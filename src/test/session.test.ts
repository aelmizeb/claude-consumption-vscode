import assert from 'node:assert/strict'
import * as os from 'node:os'
import * as path from 'node:path'
import { promises as fs } from 'node:fs'
import { test } from 'node:test'
import { Session } from '../session'

const line = (object: unknown) => JSON.stringify(object) + '\n'
const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

test('a session reads its transcript incrementally and discovers its sub-agents', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-consumption-session-'))
  const id = 'sess-1'
  const file = path.join(dir, `${id}.jsonl`)
  const at = new Date().toISOString()

  await fs.writeFile(file, line({ type: 'user', timestamp: at, message: { role: 'user', content: 'Go' } }))
  const session = new Session(id, file, 'c--proj')
  assert.equal(await session.refresh(), true)

  let loops = session.loops(Date.now(), 600_000)
  assert.equal(loops.length, 1)
  assert.equal(loops[0]?.status, 'running')

  // The Agent tool is called, then its transcript shows up.
  await fs.appendFile(
    file,
    line({ type: 'assistant', timestamp: at, message: { id: 'm1', model: 'claude-fable-5-1', content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { description: 'Explore', subagent_type: 'Explore' } }], usage } }) +
      line({ type: 'user', timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }, toolUseResult: { agentId: 'abc', description: 'Explore' } }),
  )
  await session.refresh()
  loops = session.loops(Date.now(), 600_000)
  assert.equal(loops.length, 2)
  assert.equal(loops[1]?.status, 'pending')
  assert.equal(loops[1]?.type, 'Explore')

  const sub = path.join(dir, id, 'subagents')
  await fs.mkdir(sub, { recursive: true })
  await fs.writeFile(
    path.join(sub, 'agent-abc.jsonl'),
    line({ type: 'user', isSidechain: true, agentId: 'abc', timestamp: at, message: { role: 'user', content: 'prompt' } }) +
      line({ type: 'assistant', isSidechain: true, agentId: 'abc', timestamp: at, message: { id: 'a1', model: 'claude-haiku-5-5', content: [{ type: 'tool_use', id: 't2', name: 'Grep', input: {} }], usage } }),
  )
  await session.refresh()
  loops = session.loops(Date.now(), 600_000)
  assert.equal(loops[1]?.status, 'running')
  assert.equal(loops[1]?.tool, 'Grep')
  assert.equal(loops[1]?.usage.output, 20)

  await fs.writeFile(path.join(sub, 'agent-abc.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Explore the repository', finished: true }))
  await fs.appendFile(path.join(sub, 'agent-abc.jsonl'), line({ type: 'assistant', isSidechain: true, agentId: 'abc', timestamp: at, message: { id: 'a2', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'done' }], usage, stop_reason: 'end_turn' } }))
  await session.refresh()
  loops = session.loops(Date.now(), 600_000)
  assert.equal(loops[1]?.status, 'completed')
  assert.equal(loops[1]?.description, 'Explore the repository')
  assert.equal(loops[1]?.steps, 2)
})
