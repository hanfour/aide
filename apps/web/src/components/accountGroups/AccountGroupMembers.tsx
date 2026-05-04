"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@aide/api-types";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const SELECT_CLASS =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

type Group = inferRouterOutputs<AppRouter>["accountGroups"]["get"];
type Account = inferRouterOutputs<AppRouter>["accounts"]["list"][number];

interface Props {
  orgId: string;
  group: Group;
}

export function AccountGroupMembers({ orgId, group }: Props) {
  const utils = trpc.useUtils();
  // Server-side platform narrowing: avoids pulling every anthropic account
  // when this group is openai-only (and vice versa). `accounts.list`
  // accepts an optional `platform` filter — backward-compatible.
  const { data: platformAccounts } = trpc.accounts.list.useQuery({
    orgId,
    platform: group.platform as "anthropic" | "openai",
  });

  const memberIds = useMemo(
    () => new Set(group.members.map((m) => m.accountId)),
    [group.members],
  );

  const eligibleAccounts: Account[] = useMemo(
    () => (platformAccounts ?? []).filter((a) => !memberIds.has(a.id)),
    [platformAccounts, memberIds],
  );

  const [pickedAccountId, setPickedAccountId] = useState<string>("");
  const [pickedPriority, setPickedPriority] = useState<string>("50");

  // Per-row edited priority (undefined = not edited).
  const [priorityDrafts, setPriorityDrafts] = useState<Record<string, string>>(
    {},
  );

  const invalidate = () => {
    utils.accountGroups.get.invalidate({ id: group.id });
    utils.accountGroups.list.invalidate({ orgId });
  };

  const addMember = trpc.accountGroups.addMember.useMutation({
    onSuccess: () => {
      toast.success("Member added");
      setPickedAccountId("");
      setPickedPriority("50");
      invalidate();
    },
    onError: (e) => {
      const code = (e.data as { code?: string } | undefined)?.code;
      toast.error(code === "FORBIDDEN" ? "Insufficient permission" : e.message);
    },
  });

  const removeMember = trpc.accountGroups.removeMember.useMutation({
    onSuccess: () => {
      toast.success("Member removed");
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const setPriority = trpc.accountGroups.setMemberPriority.useMutation({
    onSuccess: (_data, vars) => {
      toast.success("Priority updated");
      setPriorityDrafts((d) => {
        const next = { ...d };
        delete next[vars.accountId];
        return next;
      });
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const handleAdd = () => {
    if (!pickedAccountId) return;
    const priorityNum = Number.parseInt(pickedPriority, 10);
    if (
      !Number.isFinite(priorityNum) ||
      priorityNum < 0 ||
      priorityNum > 1000
    ) {
      toast.error("Priority must be 0-1000");
      return;
    }
    addMember.mutate({
      groupId: group.id,
      accountId: pickedAccountId,
      priority: priorityNum,
    });
  };

  const handleRemove = (accountId: string, accountName: string) => {
    if (typeof window === "undefined") return;
    const ok = window.confirm(
      `Remove "${accountName}" from group "${group.name}"? The account itself is not deleted.`,
    );
    if (!ok) return;
    removeMember.mutate({ groupId: group.id, accountId });
  };

  const handleSavePriority = (accountId: string) => {
    const draft = priorityDrafts[accountId];
    if (draft === undefined) return;
    const priorityNum = Number.parseInt(draft, 10);
    if (
      !Number.isFinite(priorityNum) ||
      priorityNum < 0 ||
      priorityNum > 1000
    ) {
      toast.error("Priority must be 0-1000");
      return;
    }
    setPriority.mutate({
      groupId: group.id,
      accountId,
      priority: priorityNum,
    });
  };

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border">
        {group.members.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            No members yet — add one of the eligible {group.platform} accounts
            below.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
                <th scope="col" className="px-4 py-2 text-left font-medium">
                  Account
                </th>
                <th scope="col" className="px-4 py-2 text-left font-medium">
                  Type
                </th>
                <th scope="col" className="px-4 py-2 text-left font-medium">
                  Status
                </th>
                <th scope="col" className="px-4 py-2 text-left font-medium">
                  Schedulable
                </th>
                <th scope="col" className="px-4 py-2 text-right font-medium">
                  Priority
                </th>
                <th scope="col" className="px-4 py-2 text-right font-medium" />
              </tr>
            </thead>
            <tbody>
              {group.members.map((m) => {
                const draft = priorityDrafts[m.accountId];
                const draftDirty =
                  draft !== undefined && Number(draft) !== m.priority;
                const busy = removeMember.isPending || setPriority.isPending;
                return (
                  <tr
                    key={m.accountId}
                    className="border-b border-border last:border-0 hover:bg-accent/20"
                  >
                    <td className="px-4 py-2.5 font-medium">
                      {m.accountName}
                      {m.accountDeletedAt !== null && (
                        <span className="ml-2 text-xs text-destructive">
                          (deleted)
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">
                      {m.accountType === "oauth" ? "OAuth" : "API key"}
                    </td>
                    <td className="px-4 py-2.5 text-xs">{m.accountStatus}</td>
                    <td className="px-4 py-2.5 text-xs">
                      {m.accountSchedulable ? "Yes" : "No"}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <div className="inline-flex items-center gap-1.5">
                        <Input
                          type="number"
                          min={0}
                          max={1000}
                          value={draft ?? String(m.priority)}
                          onChange={(e) =>
                            setPriorityDrafts((d) => ({
                              ...d,
                              [m.accountId]: e.target.value,
                            }))
                          }
                          className="h-8 w-20 text-right tabular-nums"
                        />
                        {draftDirty && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleSavePriority(m.accountId)}
                            disabled={busy}
                          >
                            Save
                          </Button>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                        onClick={() => handleRemove(m.accountId, m.accountName)}
                        disabled={busy}
                        aria-label={`Remove ${m.accountName}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="rounded-md border border-dashed border-border p-4">
        <h4 className="mb-3 text-sm font-medium">Add member</h4>
        {eligibleAccounts.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No eligible accounts — every {group.platform} account in this org is
            already a member, or there are no {group.platform} accounts at all.
            Create one in the Accounts tab first.
          </p>
        ) : (
          <div className="flex items-end gap-3">
            <div className="flex-1 space-y-1.5">
              <label
                htmlFor="add-account"
                className="text-xs text-muted-foreground"
              >
                Account
              </label>
              <select
                id="add-account"
                className={SELECT_CLASS}
                value={pickedAccountId}
                onChange={(e) => setPickedAccountId(e.target.value)}
              >
                <option value="">— Select an account —</option>
                {eligibleAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.type === "oauth" ? "OAuth" : "API key"})
                  </option>
                ))}
              </select>
            </div>
            <div className="w-32 space-y-1.5">
              <label
                htmlFor="add-priority"
                className="text-xs text-muted-foreground"
              >
                Priority
              </label>
              <Input
                id="add-priority"
                type="number"
                min={0}
                max={1000}
                value={pickedPriority}
                onChange={(e) => setPickedPriority(e.target.value)}
                className="text-right tabular-nums"
              />
            </div>
            <Button
              onClick={handleAdd}
              disabled={!pickedAccountId || addMember.isPending}
              className="gap-1.5"
            >
              <Plus className="h-4 w-4" />
              {addMember.isPending ? "Adding…" : "Add"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
