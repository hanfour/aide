"use client";

import { useState } from "react";
import { MoreHorizontal, Key, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@aide/api-types";
import { trpc } from "@/lib/trpc/client";
import { usePermissions } from "@/lib/usePermissions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusBadge, deriveAccountStatus, toDate } from "./status";

type AccountRow = inferRouterOutputs<AppRouter>["accounts"]["list"][number];

// Module-level formatter: Intl.RelativeTimeFormat construction is non-trivial,
// and we were re-creating it on every call. Hoisting keeps it cached for the
// lifetime of the process.
const RELATIVE_TIME_FORMAT = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
});

function formatRelative(ts: Date | string | null): string {
  const d = toDate(ts);
  if (!d) return "—";
  const diffMs = d.getTime() - Date.now();
  const absSec = Math.abs(diffMs) / 1000;
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 60 * 60 * 24 * 365],
    ["month", 60 * 60 * 24 * 30],
    ["day", 60 * 60 * 24],
    ["hour", 60 * 60],
    ["minute", 60],
    ["second", 1],
  ];
  for (const [unit, secs] of units) {
    if (absSec >= secs || unit === "second") {
      const value = Math.round(diffMs / 1000 / secs);
      return RELATIVE_TIME_FORMAT.format(value, unit);
    }
  }
  return d.toLocaleString();
}

interface AccountRowActionsProps {
  row: AccountRow;
  orgId: string;
  onDelete: (row: AccountRow) => void;
  isDeleting: boolean;
}

function AccountRowActions({
  row,
  orgId,
  onDelete,
  isDeleting,
}: AccountRowActionsProps) {
  const { can } = usePermissions();
  const canRotate = can({ type: "account.rotate", orgId, accountId: row.id });
  const canUpdate = can({ type: "account.update", orgId, accountId: row.id });
  const canDelete = can({ type: "account.delete", orgId, accountId: row.id });

  // If the caller has no row-level actions at all, render nothing rather than
  // a dead trigger.
  if (!canRotate && !canUpdate && !canDelete) return null;

  const handleRotate = () => {
    toast.info("Rotate flow lands in a follow-up task");
  };

  const handleEdit = () => {
    toast.info("Edit flow lands in a follow-up task");
  };

  const handleDelete = () => {
    if (typeof window === "undefined") return;
    const ok = window.confirm(
      `Remove account "${row.name}"? This marks it as deleted and unschedulable.`,
    );
    if (!ok) return;
    onDelete(row);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          aria-label={`Actions for ${row.name}`}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {canRotate && (
          <DropdownMenuItem onSelect={handleRotate}>
            <Key className="h-4 w-4" />
            Rotate credentials
          </DropdownMenuItem>
        )}
        {canUpdate && (
          <DropdownMenuItem onSelect={handleEdit}>Edit</DropdownMenuItem>
        )}
        {canDelete && (
          <>
            {(canRotate || canUpdate) && <DropdownMenuSeparator />}
            <DropdownMenuItem
              onSelect={handleDelete}
              disabled={isDeleting}
              className="text-destructive focus:text-destructive"
            >
              {isDeleting ? "Deleting…" : "Delete"}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface AccountListProps {
  orgId: string;
}

export function AccountList({ orgId }: AccountListProps) {
  const utils = trpc.useUtils();
  const {
    data: accounts,
    isLoading,
    error,
  } = trpc.accounts.list.useQuery({ orgId });
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const del = trpc.accounts.delete.useMutation({
    onSuccess: () => {
      toast.success("Account removed");
      utils.accounts.list.invalidate({ orgId });
    },
    onError: (e) => {
      const code = (e.data as { code?: string } | undefined)?.code;
      toast.error(code === "FORBIDDEN" ? "Insufficient permission" : e.message);
    },
    onSettled: () => {
      setDeletingId(null);
    },
  });

  const handleDelete = (row: AccountRow) => {
    setDeletingId(row.id);
    del.mutate({ id: row.id });
  };

  if (isLoading) {
    return (
      <Card className="shadow-card p-6 text-sm text-muted-foreground">
        Loading…
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="shadow-card flex flex-col items-center p-10 text-center">
        <ShieldAlert className="h-6 w-6 text-muted-foreground" />
        <h3 className="mt-3 text-sm font-semibold">Unable to load accounts</h3>
        <p className="mt-1 max-w-sm text-xs text-muted-foreground">
          {error.message}
        </p>
      </Card>
    );
  }

  if (!accounts || accounts.length === 0) {
    return (
      <Card className="shadow-card flex flex-col items-center p-10 text-center">
        <Key className="h-6 w-6 text-muted-foreground" />
        <h3 className="mt-3 text-sm font-semibold">No upstream accounts yet</h3>
        <p className="mt-1 max-w-sm text-xs text-muted-foreground">
          Add an Anthropic API key or OAuth credential to start routing
          requests.
        </p>
      </Card>
    );
  }

  return (
    <Card className="shadow-card overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
            <th scope="col" className="px-4 py-2 text-left font-medium">
              Name
            </th>
            <th scope="col" className="px-4 py-2 text-left font-medium">
              Platform
            </th>
            <th scope="col" className="px-4 py-2 text-left font-medium">
              Type
            </th>
            <th scope="col" className="px-4 py-2 text-left font-medium">
              Status
            </th>
            <th scope="col" className="px-4 py-2 text-right font-medium">
              Priority
            </th>
            <th scope="col" className="px-4 py-2 text-right font-medium">
              Concurrency
            </th>
            <th scope="col" className="px-4 py-2 text-left font-medium">
              Last used
            </th>
            <th scope="col" className="px-4 py-2 text-right font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((row) => {
            const status = deriveAccountStatus(row);
            const lastUsedTitle = row.lastUsedAt
              ? new Date(row.lastUsedAt).toLocaleString()
              : undefined;
            return (
              <tr
                key={row.id}
                className="border-b border-border last:border-0 hover:bg-accent/20"
              >
                <td className="px-4 py-2.5 font-medium">{row.name}</td>
                <td className="px-4 py-2.5 text-xs text-muted-foreground">
                  {row.platform}
                </td>
                <td className="px-4 py-2.5 text-xs text-muted-foreground">
                  {row.type === "oauth" ? "OAuth" : "API key"}
                </td>
                <td className="px-4 py-2.5">
                  <StatusBadge status={status} />
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  {row.priority}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  {row.concurrency}
                </td>
                <td
                  className="px-4 py-2.5 text-xs text-muted-foreground"
                  title={lastUsedTitle}
                >
                  {formatRelative(row.lastUsedAt)}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <AccountRowActions
                    row={row}
                    orgId={orgId}
                    onDelete={handleDelete}
                    isDeleting={deletingId === row.id}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}
