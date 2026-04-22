import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { organizations } from "./org.js";
import { users } from "./auth.js";

export const gdprDeleteRequests = pgTable(
  "gdpr_delete_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    reason: text("reason"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedByUserId: uuid("approved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    rejectedReason: text("rejected_reason"),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    scope: text("scope").notNull(), // 'bodies' | 'bodies_and_reports'
  },
  (t) => ({
    pendingIdx: index("gdpr_delete_requests_pending_idx").on(t.requestedAt),
    approvedIdx: index("gdpr_delete_requests_approved_idx").on(t.approvedAt),
  }),
);
