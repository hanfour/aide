import {
  pgTable,
  uuid,
  text,
  bigint,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Plan 5A migration 0009 — DB-backed model pricing.
// Replaces the JSON-loaded LiteLLM pricing path (gateway-core/pricing/) and
// the constant table in evaluator/llm/pricing.ts; both legacy paths remain
// in place until Part 3 / Part 4C-ledger refactor wires callers to the new
// PricingLookup.
//
// Storage: micros per million tokens (1 USD = 1_000_000 micros). bigint is
// chosen over numeric so on-chain arithmetic stays exact; downstream callers
// convert to dollars via Number(x) / 1_000_000.
//
// Time travel: pricing is versioned by (effective_from, effective_to). A
// future price change ships as a new migration that INSERTs a new row with
// effective_from = <change date> and UPDATEs the previous row's
// effective_to = <change date>.

export const modelPricing = pgTable(
  "model_pricing",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    platform: text("platform").notNull(),
    modelId: text("model_id").notNull(),
    inputPerMillionMicros: bigint("input_per_million_micros", {
      mode: "bigint",
    }).notNull(),
    outputPerMillionMicros: bigint("output_per_million_micros", {
      mode: "bigint",
    }).notNull(),
    cached5mPerMillionMicros: bigint("cached_5m_per_million_micros", {
      mode: "bigint",
    }),
    cached1hPerMillionMicros: bigint("cached_1h_per_million_micros", {
      mode: "bigint",
    }),
    cachedInputPerMillionMicros: bigint("cached_input_per_million_micros", {
      mode: "bigint",
    }),
    effectiveFrom: timestamp("effective_from", {
      withTimezone: true,
    }).notNull(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // UNIQUE on (platform, model_id, effective_from) doubles as the lookup
    // index — PostgreSQL scans a unique B-tree index in reverse direction
    // efficiently for `ORDER BY effective_from DESC LIMIT 1`. A separate
    // non-unique idx on the same columns (as drafted in design §4.2) would
    // be redundant disk + write cost.
    activeIdx: uniqueIndex("model_pricing_active_idx").on(
      t.platform,
      t.modelId,
      t.effectiveFrom,
    ),
  }),
);
