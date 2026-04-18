import {
  pgTable,
  text,
  timestamp,
  uuid,
  index,
  pgEnum,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";

export const roleEnum = pgEnum("role_name", [
  "super_admin",
  "org_admin",
  "dept_manager",
  "team_manager",
  "member",
]);

export const scopeTypeEnum = pgEnum("scope_type", [
  "global",
  "organization",
  "department",
  "team",
]);

export const roleAssignments = pgTable(
  "role_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: roleEnum("role").notNull(),
    scopeType: scopeTypeEnum("scope_type").notNull(),
    scopeId: uuid("scope_id"),
    grantedBy: uuid("granted_by").references(() => users.id),
    grantedAt: timestamp("granted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => ({
    activeByUser: index("idx_role_assignments_user_active").on(t.userId),
  }),
);
