"use client";

import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { trpc } from "@/lib/trpc/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RequirePerm } from "@/components/RequirePerm";
import {
  TimeRangePicker,
  rangeToDates,
  type RangePreset,
} from "@/components/usage/TimeRangePicker";
import { UsageSummaryCards } from "@/components/usage/UsageSummaryCards";
import { UsageChart } from "@/components/usage/UsageChart";
import { UsageTable } from "@/components/usage/UsageTable";

// TODO: tabs for team/member scope switching. The server accepts
// usage.read_team / usage.read_user but the task 9.6 cut is org-only.

export default function OrgUsagePage() {
  const params = useParams();
  const orgId = params?.id as string;
  const [range, setRange] = useState<RangePreset>("30d");
  const { from, to } = useMemo(() => rangeToDates(range), [range]);

  const summaryQuery = trpc.usage.summary.useQuery({
    scope: { type: "org", orgId },
    from,
    to,
  });

  return (
    <RequirePerm
      action={{ type: "usage.read_org", orgId }}
      fallback={
        <Card className="shadow-card p-6 text-sm text-muted-foreground">
          You do not have permission to view usage for this organization.
        </Card>
      }
    >
      <div className="space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">Usage</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Requests, token spend, and cost across the organization.
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
              Top models by cost
            </CardTitle>
          </CardHeader>
          <CardContent>
            <UsageChart byModel={summaryQuery.data?.byModel ?? []} />
          </CardContent>
        </Card>

        <Card className="shadow-card">
          <CardHeader>
            <CardTitle className="text-sm font-medium">Requests</CardTitle>
          </CardHeader>
          <CardContent>
            <UsageTable
              scope={{ type: "org", orgId }}
              from={from}
              to={to}
            />
          </CardContent>
        </Card>
      </div>
    </RequirePerm>
  );
}
