"use client";

import { use } from "react";
import { RequirePerm } from "@/components/RequirePerm";
import { StatusCard } from "@/components/evaluator/StatusCard";

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
        <StatusCard orgId={orgId} />
      </div>
    </RequirePerm>
  );
}
