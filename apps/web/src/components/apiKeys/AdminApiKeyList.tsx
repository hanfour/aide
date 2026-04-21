"use client";

import { useState } from "react";
import { KeyRound, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@aide/api-types";
import { trpc } from "@/lib/trpc/client";
import { formatRelative, toDate } from "@/lib/time";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  adminStatusClassName,
  ADMIN_STATUS_LABEL,
  deriveAdminKeyStatus,
} from "./adminStatus";

type AdminKeyRow = inferRouterOutputs<AppRouter>["apiKeys"]["listOrg"][number];

function formatCreated(ts: Date | string | null): string {
  const d = toDate(ts);
  if (!d) return "—";
  return d.toLocaleDateString();
}

interface Props {
  orgId: string;
  targetUserId: string;
}

export function AdminApiKeyList({ orgId, targetUserId }: Props) {
  const utils = trpc.useUtils();
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const {
    data: keys,
    isLoading,
    error,
  } = trpc.apiKeys.listOrg.useQuery({ orgId });

  const revoke = trpc.apiKeys.revoke.useMutation({
    onSuccess: () => {
      toast.success("Key revoked");
      utils.apiKeys.listOrg.invalidate({ orgId });
    },
    onError: (e) => {
      const code = (e.data as { code?: string } | undefined)?.code;
      toast.error(
        code === "FORBIDDEN" ? "Insufficient permission" : e.message,
      );
    },
    onSettled: () => setRevokingId(null),
  });

  const handleRevoke = (row: AdminKeyRow) => {
    if (typeof window === "undefined") return;
    const ok = window.confirm(
      `Revoke key "${row.name}"? This cannot be undone.`,
    );
    if (!ok) return;
    setRevokingId(row.id);
    revoke.mutate({ id: row.id });
  };

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (error) {
    return <p className="text-xs text-destructive">{error.message}</p>;
  }

  // Client-side filter: `listOrg` returns every key in the org; the admin page
  // wants only those belonging to the target user. Filtering here (vs adding a
  // server-side userId filter) keeps the tRPC surface small and lets React
  // Query share the org-wide cache with any future admin-wide list view.
  const rows = (keys ?? []).filter((r) => r.userId === targetUserId);
  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center py-6 text-center">
        <KeyRound className="h-5 w-5 text-muted-foreground" />
        <p className="mt-2 text-sm text-muted-foreground">
          No keys issued for this user yet.
        </p>
      </div>
    );
  }

  return (
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
            <th scope="col" className="px-3 py-2 text-right font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const status = deriveAdminKeyStatus(row);
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
                  <Badge
                    variant="outline"
                    className={adminStatusClassName(status)}
                  >
                    {ADMIN_STATUS_LABEL[status]}
                  </Badge>
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
  );
}
