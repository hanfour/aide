import { z } from "zod";

export const llmEvidenceSchema = z.object({
  quote: z.string().min(1),
  requestId: z.string().min(1),
  rationale: z.string().min(1),
});

export const llmSectionAdjustmentSchema = z.object({
  sectionId: z.string().min(1),
  adjustment: z.number().gte(-10).lte(10),
  rationale: z.string().min(1),
});

export const llmResponseSchema = z.object({
  narrative: z.string().min(1),
  evidence: z.array(llmEvidenceSchema),
  sectionAdjustments: z.array(llmSectionAdjustmentSchema),
});

export type LlmEvidence = z.infer<typeof llmEvidenceSchema>;
export type LlmSectionAdjustment = z.infer<typeof llmSectionAdjustmentSchema>;
export type LlmResponse = z.infer<typeof llmResponseSchema>;

export type ParseResult =
  | ({ ok: true } & LlmResponse)
  | { ok: false; error: string };

const FENCE = /^```(?:json)?\s*([\s\S]*?)\s*```$/;

export function parseLlmResponse(input: unknown): ParseResult {
  const candidate = coerceToObject(input);
  if (candidate === null) {
    return { ok: false, error: "Input is not a JSON object or JSON string" };
  }

  const result = llmResponseSchema.safeParse(candidate);
  if (!result.success) {
    return { ok: false, error: result.error.message };
  }
  return { ok: true, ...result.data };
}

function coerceToObject(input: unknown): unknown {
  if (typeof input === "string") {
    const stripped = input.trim().replace(FENCE, "$1").trim();
    try {
      return JSON.parse(stripped);
    } catch {
      return null;
    }
  }
  if (input === null || input === undefined) return null;
  if (typeof input !== "object") return null;
  if (Array.isArray(input)) return null;
  return input;
}
