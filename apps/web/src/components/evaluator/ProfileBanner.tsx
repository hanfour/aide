"use client";

import { Info } from "lucide-react";
import { trpc } from "@/lib/trpc/client";

// Default retention when no org override is configured.
// Matches DEFAULT_RETENTION_DAYS in apps/gateway/src/runtime/bodyCapture.ts.
const DEFAULT_RETENTION_DAYS = 90;

export function ProfileBanner() {
  const { data: session, isLoading } = trpc.me.session.useQuery();

  if (isLoading) {
    return (
      <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground animate-pulse">
        Loading disclosure…
      </div>
    );
  }

  // Determine whether the caller belongs to any org that has content capture on.
  // me.session exposes coveredOrgs (org IDs where caller has any role).
  // We cannot call contentCapture.getSettings here (requires org_admin),
  // so we render a generic disclosure and let admins handle specifics.
  const hasOrg = session?.coveredOrgs && session.coveredOrgs.length > 0;

  if (!hasOrg) {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/20 px-4 py-3">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="space-y-1 text-sm">
          <p className="font-medium">Content capture is not currently enabled for your organization.</p>
          <p className="text-muted-foreground text-xs">
            No evaluation data is being collected. Contact your administrator if you have questions.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 dark:border-blue-900/50 dark:bg-blue-950/20">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
      <div className="space-y-1.5 text-sm">
        <p className="font-medium text-blue-900 dark:text-blue-100">
          Content capture is enabled for your account.
        </p>
        <p className="text-blue-800/80 dark:text-blue-200/80 text-xs leading-relaxed">
          Request content associated with your API key is retained for up to{" "}
          <strong>{DEFAULT_RETENTION_DAYS} days</strong> (your organization may
          configure a shorter retention window). Evaluations are generated
          automatically by a nightly process using your organization&apos;s rubric.
        </p>
        <p className="text-blue-700/70 dark:text-blue-300/70 text-xs">
          For questions about data retention or to request deletion, contact your
          organization administrator. You can also use the export and deletion
          options at the bottom of this page.
        </p>
      </div>
    </div>
  );
}
