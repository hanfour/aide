"use client";

import Link from "next/link";
import { use } from "react";
import { RequirePerm } from "@/components/RequirePerm";
import { StatusCard } from "@/components/evaluator/StatusCard";
import { CostSummaryCard } from "@/components/evaluator/CostSummaryCard";

export default function EvaluatorStatusPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: orgId } = use(params);
  return (
    <RequirePerm action={{ type: "evaluator.read_status", orgId }}>
      <div className="container max-w-3xl py-8 space-y-6">
        <header>
          <h1 className="text-2xl font-semibold">Evaluator Status</h1>
          <p className="text-sm text-muted-foreground">
            Current cron health and coverage.
          </p>
        </header>
        <RequirePerm action={{ type: "evaluator.view_cost", orgId }}>
          <div className="space-y-2">
            <CostSummaryCard orgId={orgId} variant="compact" />
            <div className="text-right">
              <Link
                href={`/dashboard/organizations/${orgId}/evaluator/costs`}
                className="text-sm text-primary hover:underline"
              >
                View cost dashboard →
              </Link>
            </div>
          </div>
        </RequirePerm>
        <StatusCard orgId={orgId} />
      </div>
    </RequirePerm>
  );
}
