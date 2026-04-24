import {
  pgTable,
  uuid,
  text,
  integer,
  decimal,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { organizations } from "./org.js";

export const llmUsageEvents = pgTable(
  "llm_usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(), // 'facet_extraction' | 'deep_analysis'
    model: text("model").notNull(),
    tokensInput: integer("tokens_input").notNull(),
    tokensOutput: integer("tokens_output").notNull(),
    costUsd: decimal("cost_usd", { precision: 10, scale: 6 }).notNull(),
    refType: text("ref_type"), // 'request_body_facet' | 'evaluation_report' | null
    refId: uuid("ref_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    orgMonthIdx: index("llm_usage_org_month_idx").on(t.orgId, t.createdAt),
  }),
);
