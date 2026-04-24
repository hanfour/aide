export interface ModelPricing {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

export const PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-7": { inputUsdPerMTok: 15, outputUsdPerMTok: 75 },
  "claude-sonnet-4-6": { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
  "claude-haiku-4-5": { inputUsdPerMTok: 0.8, outputUsdPerMTok: 4 },
};

export function calculateCost(
  model: string,
  tokensIn: number,
  tokensOut: number,
): number {
  const p = PRICING[model];
  if (!p) throw new Error(`Unknown model for pricing: ${model}`);
  return (
    (tokensIn * p.inputUsdPerMTok) / 1_000_000 +
    (tokensOut * p.outputUsdPerMTok) / 1_000_000
  );
}
