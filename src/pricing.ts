import { FleetUsage } from './types'

/**
 * Public Anthropic API prices, in dollars per million tokens. Cache writes cost 1.25× the input price for
 * five minutes and 2× the input price for one hour (what Claude Code uses). These figures reproduce
 * exactly the `costUSD` Claude Code writes in its `cost-state` lines.
 */
export type Price = { input: number; output: number; cacheRead: number }

const PRICES: Record<string, Price> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-mythos-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
}

/** The model name reduced to its pricing key: no platform prefix, no date suffix, no `[1m]`. */
export function normalizeModel(model: string): string {
  return model
    .toLowerCase()
    .replace(/\[1m\]$/, '')
    .replace(/^(us|eu|apac|global)\./, '')
    .replace(/^anthropic\./, '')
    .replace(/-\d{8}$/, '')
    .replace(/@\d{8}$/, '')
    .replace(/-v\d+(:\d+)?$/, '')
}

export function priceFor(model: string | undefined): Price | undefined {
  if (!model) return undefined

  return PRICES[normalizeModel(model)]
}

/** The cost in dollars of a usage on a model, or `undefined` when the model has no known price. */
export function estimateUsd(usage: FleetUsage, model: string | undefined): number | undefined {
  const price = priceFor(model)

  if (!price) return undefined

  const write5m = Math.max(0, usage.cacheWrite - usage.cacheWrite1h)

  return (
    (usage.input * price.input +
      usage.output * price.output +
      usage.cacheRead * price.cacheRead +
      write5m * price.input * 1.25 +
      usage.cacheWrite1h * price.input * 2) /
    1_000_000
  )
}

/** The cost of a per-model usage: the sum of the priced models, and whether some are not priced. */
export function estimateByModel(byModel: Record<string, FleetUsage>): { usd: number; priced: boolean; partial: boolean } {
  let usd = 0
  let priced = false
  let partial = false

  for (const [model, usage] of Object.entries(byModel)) {
    const cost = estimateUsd(usage, model)

    if (cost === undefined) partial = true
    else {
      usd += cost
      priced = true
    }
  }

  return { usd, priced, partial }
}

/**
 * The comparison model: DeepSeek's most expensive offer, `deepseek-v4-pro` at peak rates, in USD per
 * million tokens (https://api-docs.deepseek.com/quick_start/pricing/, read on 2026-10-29; off-peak rates
 * are half of these). DeepSeek bills cached input at the cache-hit price and does not bill cache writes:
 * the tokens Claude writes to its cache count here as cache misses.
 */
export const COMPARE_MODEL = 'deepseek-v4-pro'
export const COMPARE_LABEL = 'DEEPSEEK'
export const COMPARE_PRICE = { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 } as const

/** What a usage would have cost on the comparison model. */
export function compareUsd(usage: FleetUsage): number {
  return ((usage.input + usage.cacheWrite) * COMPARE_PRICE.cacheMiss + usage.cacheRead * COMPARE_PRICE.cacheHit + usage.output * COMPARE_PRICE.output) / 1_000_000
}

/** A model's context window, in tokens: 1M for the 5 family, 200k before, 1M when `[1m]` is requested. */
export function contextWindowFor(model: string | undefined, settingsModel: string | undefined): number {
  const wantsLong = /\[1m\]/i.test(model ?? '') || /\[1m\]/i.test(settingsModel ?? '')
  const key = normalizeModel(model ?? '')

  if (/^claude-(opus|sonnet|haiku)-5(-\d+)?$/.test(key) || /^claude-(fable|mythos)/.test(key)) return 1_000_000

  return wantsLong ? 1_000_000 : 200_000
}
