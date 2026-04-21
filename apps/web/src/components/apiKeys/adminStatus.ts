// Admin-level API key status inference + badge tone mapping.
//
// Distinguishes four states the self-service view does not need:
//
//   active         — self-issued (no reveal token ever minted).
//   pending_reveal — admin-issued, one-time URL outstanding, not yet claimed.
//   reveal_expired — admin-issued, URL window lapsed, user never claimed.
//   claimed        — admin-issued, target user claimed the raw via the URL.
//
// This lives next to the admin page (not shared globally) because the
// reveal-flow fields only appear on the org-admin listOrg projection.

import { toDate } from "@/lib/time";

export type AdminKeyStatus =
  | "active"
  | "pending_reveal"
  | "reveal_expired"
  | "claimed";

// Structural input — AdminKeyRow in the page file satisfies this without a
// cast. Timestamps accept `Date | string | null` because tRPC without a
// superjson transformer serializes Dates as ISO strings over the wire.
export interface AdminKeyStatusInput {
  revealedAt: Date | string | null;
  revealTokenExpiresAt: Date | string | null;
}

// Precedence: the reveal bookkeeping is authoritative.
// - revealedAt set -> claimed (admin-issued, successfully transferred).
// - revealTokenExpiresAt set but no revealedAt -> admin-issued, outstanding;
//   pending vs expired decided by wall clock.
// - neither set -> self-issued; surface as plain `active`.
export function deriveAdminKeyStatus(
  row: AdminKeyStatusInput,
  now: Date = new Date(),
): AdminKeyStatus {
  const revealedAt = toDate(row.revealedAt);
  if (revealedAt) return "claimed";

  const expiresAt = toDate(row.revealTokenExpiresAt);
  if (expiresAt) {
    return expiresAt > now ? "pending_reveal" : "reveal_expired";
  }

  return "active";
}

export const ADMIN_STATUS_LABEL: Record<AdminKeyStatus, string> = {
  active: "Active",
  pending_reveal: "Pending reveal",
  reveal_expired: "Reveal expired",
  claimed: "Claimed",
};

// Matches the apple-palette tones in components/accounts/status.tsx so the two
// tables feel consistent without duplicating the full tone system here.
const TONE_CLASSNAME: Record<AdminKeyStatus, string> = {
  active:
    "border-transparent bg-emerald-100 font-medium text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300",
  claimed:
    "border-transparent bg-emerald-100 font-medium text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300",
  pending_reveal:
    "border-transparent bg-amber-100 font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
  reveal_expired:
    "border-transparent bg-rose-100 font-medium text-rose-800 dark:bg-rose-500/15 dark:text-rose-300",
};

export function adminStatusClassName(status: AdminKeyStatus): string {
  return TONE_CLASSNAME[status];
}
