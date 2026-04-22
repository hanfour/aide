import { z } from "zod";

// Metric names used by `threshold` signals. Aligned with metric aggregator in Task 2.5.
export const metricEnum = z.enum([
  "requests",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
  "total_cost",
  "cache_read_ratio",
  "model_diversity",
  "client_mix_ratio",
  "refusal_rate",
  "body_capture_coverage",
  "tool_diversity",
  "iteration_count",
]);

export const signalSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("keyword"),
    id: z.string(),
    in: z.enum(["request_body", "response_body", "both"]),
    terms: z.array(z.string()).min(1),
    caseSensitive: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("threshold"),
    id: z.string(),
    metric: metricEnum,
    gte: z.number().optional(),
    lte: z.number().optional(),
    between: z.tuple([z.number(), z.number()]).optional(),
  }),
  z.object({
    type: z.literal("refusal_rate"),
    id: z.string(),
    lte: z.number(),
  }),
  z.object({
    type: z.literal("client_mix"),
    id: z.string(),
    expect: z.array(z.string()).min(1),
    minRatio: z.number(),
  }),
  z.object({
    type: z.literal("model_diversity"),
    id: z.string(),
    gte: z.number(),
  }),
  z.object({
    type: z.literal("cache_read_ratio"),
    id: z.string(),
    gte: z.number(),
  }),
  z.object({
    type: z.literal("extended_thinking_used"),
    id: z.string(),
    minCount: z.number(),
  }),
  z.object({
    type: z.literal("tool_diversity"),
    id: z.string(),
    gte: z.number(),
  }),
  z.object({
    type: z.literal("iteration_count"),
    id: z.string(),
    gte: z.number(),
  }),
]);

export const sectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  weight: z.string().regex(/^\d{1,3}%$/),
  standard: z.object({
    score: z.number(),
    label: z.string(),
    criteria: z.array(z.string()),
  }),
  superior: z.object({
    score: z.number(),
    label: z.string(),
    criteria: z.array(z.string()),
  }),
  signals: z.array(signalSchema),
  superiorRules: z
    .object({
      strongThresholds: z.array(z.string()),
      supportThresholds: z.array(z.string()),
      minStrongHits: z.number().default(1),
      minSupportHits: z.number().default(1),
    })
    .optional(),
});

export const rubricSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  version: z.string(),
  locale: z.enum(["en", "zh-Hant", "ja"]).default("en"),
  sections: z.array(sectionSchema).min(1),
  noiseFilters: z.array(z.string()).optional(),
});

export type Rubric = z.infer<typeof rubricSchema>;
export type Section = z.infer<typeof sectionSchema>;
export type Signal = z.infer<typeof signalSchema>;
export type Metric = z.infer<typeof metricEnum>;
