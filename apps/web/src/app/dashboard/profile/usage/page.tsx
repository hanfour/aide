"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  TimeRangePicker,
  rangeToDates,
  type RangePreset,
} from "@/components/usage/TimeRangePicker";
import { UsageSummaryCards } from "@/components/usage/UsageSummaryCards";
import { UsageChart } from "@/components/usage/UsageChart";
import { UsageTable } from "@/components/usage/UsageTable";

// No RequirePerm: every authenticated session has `usage.read_own` by default,
// and the server's ensureCanReadScope is the authoritative gate either way.

export default function ProfileUsagePage() {
  const [range, setRange] = useState<RangePreset>("30d");
  const { from, to } = useMemo(() => rangeToDates(range), [range]);
  const t = useTranslations("profileUsage");
  const tOrgUsage = useTranslations("usage");

  const summaryQuery = trpc.usage.summary.useQuery({
    scope: { type: "own" },
    from,
    to,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">{t("title")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("subtitle")}
          </p>
        </div>
        <TimeRangePicker value={range} onChange={setRange} />
      </div>

      {summaryQuery.error ? (
        <Card className="shadow-card p-6 text-sm text-muted-foreground">
          {summaryQuery.error.message}
        </Card>
      ) : (
        <UsageSummaryCards
          summary={summaryQuery.data}
          isLoading={summaryQuery.isLoading}
        />
      )}

      <Card className="shadow-card">
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            {tOrgUsage("topModels")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <UsageChart byModel={summaryQuery.data?.byModel ?? []} />
        </CardContent>
      </Card>

      <Card className="shadow-card">
        <CardHeader>
          <CardTitle className="text-sm font-medium">{tOrgUsage("requestsTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <UsageTable scope={{ type: "own" }} from={from} to={to} />
        </CardContent>
      </Card>
    </div>
  );
}
