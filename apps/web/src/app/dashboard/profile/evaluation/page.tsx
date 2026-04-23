"use client";

import { ProfileEvaluation } from "@/components/evaluator/ProfileEvaluation";

export default function ProfileEvaluationPage() {
  return (
    <div className="container max-w-5xl py-8 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">My Evaluation</h1>
        <p className="text-sm text-muted-foreground">
          Transparency about how your AI-assisted work is scored.
        </p>
      </header>
      <ProfileEvaluation />
    </div>
  );
}
