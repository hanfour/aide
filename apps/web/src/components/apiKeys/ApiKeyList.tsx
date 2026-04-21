"use client";

import { useState } from "react";
import { Plus, Trash2, KeyRound } from "lucide-react";
import { toast } from "sonner";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@aide/api-types";
import { trpc } from "@/lib/trpc/client";
import { toDate, formatRelative } from "@/lib/time";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ApiKeyCreateDialog } from "./ApiKeyCreateDialog";

type ApiKeyRow = inferRouterOutputs<AppRouter>["apiKeys"]["listOwn"][number];

function formatCreated(ts: Date | string | null): string {
  const d = toDate(ts);
  if (!d) return "—";
  return d.toLocaleDateString();
}

// `listOwn` filters revoked rows server-side, so today every row is "active".
// Surface a dedicated badge anyway for forward-compat (e.g. expired/suspended
// states the server may add later).
function StatusBadge({ status }: { status: string }) {
  const isActive = status === "active";
  return (
    <Badge
      variant="outline"
      className={
        isActive
          ? "border-transparent bg-emerald-100 font-medium text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300"
          : "border-transparent bg-slate-100 font-medium text-slate-700 dark:bg-slate-500/15 dark:text-slate-300"
      }
    >
      {isActive ? "Active" : status}
    </Badge>
  );
}

export function ApiKeyList() {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const { data: keys, isLoading, error } = trpc.apiKeys.listOwn.useQuery();

  const revoke = trpc.apiKeys.revoke.useMutation({
    onSuccess: () => {
      toast.success("Key revoked");
      utils.apiKeys.listOwn.invalidate();
    },
    onError: (e) => {
      const code = (e.data as { code?: string } | undefined)?.code;
      toast.error(code === "FORBIDDEN" ? "Insufficient permission" : e.message);
    },
    onSettled: () => {
      setRevokingId(null);
    },
  });

  const handleRevoke = (row: ApiKeyRow) => {
    if (typeof window === "undefined") return;
    const ok = window.confirm(
      `Revoke key "${row.name}"? This cannot be undone.`,
    );
    if (!ok) return;
    setRevokingId(row.id);
    revoke.mutate({ id: row.id });
  };

  return (
    <Card className="shadow-card">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm font-medium">API keys</CardTitle>
        <Button size="sm" className="gap-1.5" onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" />
          New key
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="text-xs text-destructive">{error.message}</p>
        ) : !keys || keys.length === 0 ? (
          <div className="flex flex-col items-center py-6 text-center">
            <KeyRound className="h-5 w-5 text-muted-foreground" />
            <p className="mt-2 text-sm text-muted-foreground">
              No API keys yet. Generate one to use the gateway.
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    Name
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    Prefix
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    Status
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    Created
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    Last used
                  </th>
                  <th
                    scope="col"
                    className="px-3 py-2 text-right font-medium"
                  ></th>
                </tr>
              </thead>
              <tbody>
                {keys.map((row) => {
                  const lastUsedTitle = row.lastUsedAt
                    ? new Date(row.lastUsedAt).toLocaleString()
                    : undefined;
                  const isRevoking = revokingId === row.id;
                  return (
                    <tr
                      key={row.id}
                      className="border-b border-border last:border-0 hover:bg-accent/20"
                    >
                      <td className="px-3 py-2 font-medium">{row.name}</td>
                      <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                        {row.prefix}
                      </td>
                      <td className="px-3 py-2">
                        <StatusBadge status={row.status} />
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {formatCreated(row.createdAt)}
                      </td>
                      <td
                        className="px-3 py-2 text-xs text-muted-foreground"
                        title={lastUsedTitle}
                      >
                        {formatRelative(row.lastUsedAt)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                          onClick={() => handleRevoke(row)}
                          disabled={isRevoking}
                          aria-label={`Revoke ${row.name}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
      <ApiKeyCreateDialog open={open} onOpenChange={setOpen} />
    </Card>
  );
}
