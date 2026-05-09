"use client";

import { useTranslations } from "next-intl";
import { ProfileEvaluation } from "@/components/evaluator/ProfileEvaluation";

export default function ProfileEvaluationPage() {
  const t = useTranslations("profileEvaluation");
  return (
    <div className="container max-w-5xl py-8 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("pageSubtitle")}
        </p>
      </header>
      <ProfileEvaluation />
    </div>
  );
}
