import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compareUsd, contextWindowFor, estimateUsd, normalizeModel } from '../pricing'

test('the DeepSeek equivalent bills cache reads as hits, cache writes as misses', () => {
  // 1M of each: 1.32 (input) + 1.32 (cache write, a miss) + 0.044 (cache read, a hit) + 3.96 (output).
  const usd = compareUsd({ input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, cacheWrite1h: 1_000_000 })
  assert.ok(Math.abs(usd - 6.644) < 1e-9, String(usd))
})

test('the estimate reproduces the costUSD Claude Code writes (1h cache billed twice the input price)', () => {
  // Taken from a real cost-state line: claude-fable-5-1, $13.098226.
  const fable = estimateUsd({ input: 2480, output: 72381, cacheRead: 17_429_985, cacheWrite: 254_844, cacheWrite1h: 254_844 }, 'claude-fable-5-1')
  assert.ok(fable !== undefined && Math.abs(fable - 13.098226) < 1e-4, String(fable))

  const haiku = estimateUsd({ input: 1195, output: 143, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 }, 'claude-haiku-5-5')
  assert.ok(haiku !== undefined && Math.abs(haiku - 0.000191) < 1e-7, String(haiku))
})

test('an unknown model has no price', () => {
  assert.equal(estimateUsd({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 }, 'claude-opus-4-5'), undefined)
  assert.equal(estimateUsd({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 }, undefined), undefined)
})

test('model names are reduced to their pricing key', () => {
  assert.equal(normalizeModel('claude-fable-5-1[1m]'), 'claude-fable-5-1')
  assert.equal(normalizeModel('us.anthropic.claude-opus-5-5-20260401'), 'claude-opus-5-5')
  assert.equal(normalizeModel('claude-sonnet-5-5@20260301'), 'claude-sonnet-5-5')
})

test('the context window depends on the family and on [1m]', () => {
  assert.equal(contextWindowFor('claude-fable-5-1', undefined), 1_000_000)
  assert.equal(contextWindowFor('claude-opus-5-5', undefined), 1_000_000)
  assert.equal(contextWindowFor('claude-haiku-4-5', undefined), 200_000)
  assert.equal(contextWindowFor('claude-opus-4-6', 'opus[1m]'), 1_000_000)
  assert.equal(contextWindowFor('claude-opus-4-6', undefined), 200_000)
})
