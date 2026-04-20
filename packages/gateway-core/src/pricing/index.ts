import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

export interface ModelPricing {
  input_cost_per_token: number
  output_cost_per_token: number
  cache_creation_input_token_cost?: number
  cache_read_input_token_cost?: number
}

export interface Tokens {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
}

export interface CostBreakdown {
  inputCost: number
  outputCost: number
  cacheCreationCost: number
  cacheReadCost: number
  totalCost: number
  miss: boolean
}

export type PricingMap = Map<string, ModelPricing>

export function loadPricing(): PricingMap {
  const here = dirname(fileURLToPath(import.meta.url))
  const path = join(here, '..', '..', 'pricing', 'litellm.json')
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, ModelPricing>
  const map = new Map<string, ModelPricing>()
  for (const [model, price] of Object.entries(raw)) {
    map.set(model.toLowerCase(), price)
  }
  return map
}

export function resolveCost(pricing: PricingMap, model: string, tokens: Tokens): CostBreakdown {
  const p = pricing.get(model.toLowerCase())
  if (!p) {
    return { inputCost: 0, outputCost: 0, cacheCreationCost: 0, cacheReadCost: 0, totalCost: 0, miss: true }
  }
  const inputCost = tokens.inputTokens * p.input_cost_per_token
  const outputCost = tokens.outputTokens * p.output_cost_per_token
  const cacheCreationCost = tokens.cacheCreationTokens * (p.cache_creation_input_token_cost ?? 0)
  const cacheReadCost = tokens.cacheReadTokens * (p.cache_read_input_token_cost ?? 0)
  return {
    inputCost,
    outputCost,
    cacheCreationCost,
    cacheReadCost,
    totalCost: inputCost + outputCost + cacheCreationCost + cacheReadCost,
    miss: false,
  }
}
