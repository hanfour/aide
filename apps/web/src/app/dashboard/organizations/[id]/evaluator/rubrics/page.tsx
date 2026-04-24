"use client";

import { use } from "react";
import { RequirePerm } from "@/components/RequirePerm";
import { RubricList } from "@/components/evaluator/RubricList";

export default function RubricsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: orgId } = use(params);
  return (
    <RequirePerm action={{ type: "rubric.read", orgId }}>
      <div className="container max-w-5xl py-8 space-y-6">
        <header>
          <h1 className="text-2xl font-semibold">Rubrics</h1>
          <p className="text-sm text-muted-foreground">
            Customize how your organization scores AI-assisted development.
          </p>
        </header>
        <RubricList orgId={orgId} />
      </div>
    </RequirePerm>
  );
}
