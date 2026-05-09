"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { FileText } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

export default function AuditTab() {
  const params = useParams();
  const orgId = params?.id as string;
  const [actionFilter, setActionFilter] = useState("");
  const t = useTranslations("audit");
  const tPage = useTranslations("auditPage");
  const tCommon = useTranslations("common");
  const {
    data: logs,
    isLoading,
    error,
  } = trpc.auditLogs.list.useQuery({
    orgId,
    action: actionFilter.trim() || undefined,
    limit: 100,
  });

  if (error) {
    return (
      <Card className="shadow-card p-6 text-sm text-muted-foreground">
        {error.message}
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Input
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          placeholder={tPage("filterPlaceholder")}
          className="max-w-xs"
        />
      </div>

      {isLoading ? (
        <Card className="shadow-card p-6 text-sm text-muted-foreground">
          {tCommon("loading")}
        </Card>
      ) : !logs || logs.length === 0 ? (
        <Card className="shadow-card flex flex-col items-center p-10 text-center">
          <FileText className="h-6 w-6 text-muted-foreground" />
          <h3 className="mt-3 text-sm font-semibold">{t("empty")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("emptyHint")}
          </p>
        </Card>
      ) : (
        <Card className="shadow-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
                <th className="px-4 py-2 text-left font-medium">{t("headers.when")}</th>
                <th className="px-4 py-2 text-left font-medium">{t("headers.actor")}</th>
                <th className="px-4 py-2 text-left font-medium">{t("headers.action")}</th>
                <th className="px-4 py-2 text-left font-medium">{t("headers.target")}</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr
                  key={String(l.id)}
                  className="border-b border-border last:border-0 hover:bg-accent/20"
                >
                  <td className="px-4 py-2 whitespace-nowrap text-xs text-muted-foreground">
                    {new Date(l.createdAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {l.actorEmail ?? (l.actorUserId ? l.actorUserId.slice(0, 8) : "—")}
                  </td>
                  <td className="px-4 py-2">
                    <Badge
                      variant="secondary"
                      className="rounded-md font-mono text-[10px] font-normal"
                    >
                      {l.action}
                    </Badge>
                  </td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">
                    {l.targetType
                      ? `${l.targetType}:${l.targetId?.slice(0, 8) ?? "—"}`
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
