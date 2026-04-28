import {
  pgTable,
  uuid,
  text,
  decimal,
  boolean,
  timestamp,
  integer,
  primaryKey,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./org.js";
import { upstreamAccounts } from "./accounts.js";

export const accountGroups = pgTable(
  "account_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    platform: text("platform").notNull(),
    rateMultiplier: decimal("rate_multiplier", { precision: 10, scale: 4 })
      .notNull()
      .default("1.0"),
    isExclusive: boolean("is_exclusive").notNull().default(false),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    orgPlatformIdx: index("account_groups_org_platform_idx")
      .on(t.orgId, t.platform)
      .where(sql`${t.deletedAt} IS NULL`),
    orgNameUnique: unique("account_groups_org_name_unique").on(t.orgId, t.name),
  }),
);

export const accountGroupMembers = pgTable(
  "account_group_members",
  {
    accountId: uuid("account_id")
      .notNull()
      .references(() => upstreamAccounts.id, { onDelete: "cascade" }),
    groupId: uuid("group_id")
      .notNull()
      .references(() => accountGroups.id, { onDelete: "cascade" }),
    priority: integer("priority").notNull().default(50),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.accountId, t.groupId] }),
    groupPriorityIdx: index("account_group_members_group_priority_idx").on(
      t.groupId,
      t.priority,
    ),
  }),
);
