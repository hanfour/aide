"use client";

import { use } from "react";
import { RequirePerm } from "@/components/RequirePerm";
import { SettingsForm } from "@/components/evaluator/SettingsForm";

export default function EvaluatorSettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: orgId } = use(params);
  return (
    <RequirePerm action={{ type: "content_capture.toggle", orgId }}>
      <div className="container max-w-3xl py-8 space-y-6">
        <header>
          <h1 className="text-2xl font-semibold">Evaluator Settings</h1>
          <p className="text-sm text-muted-foreground">
            Configure content capture and evaluation for this organization.
          </p>
        </header>
        <SettingsForm orgId={orgId} />
      </div>
    </RequirePerm>
  );
}
