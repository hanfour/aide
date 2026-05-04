"use client";

import { useParams } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { Card } from "@/components/ui/card";
import { RequirePerm } from "@/components/RequirePerm";
import { AccountGroupList } from "@/components/accountGroups/AccountGroupList";

export default function AccountGroupsPage() {
  const params = useParams();
  const orgId = params?.id as string;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold tracking-tight">Account groups</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Pool upstream accounts of the same platform under a shared rate cap;
          the gateway scheduler load-balances across members by priority.
        </p>
      </div>

      <RequirePerm
        action={{ type: "account_group.read", orgId }}
        fallback={
          <Card className="shadow-card flex flex-col items-center p-10 text-center">
            <ShieldAlert className="h-6 w-6 text-muted-foreground" />
            <h3 className="mt-3 text-sm font-semibold">
              You can&apos;t view groups here
            </h3>
            <p className="mt-1 max-w-sm text-xs text-muted-foreground">
              Ask a workspace admin for the{" "}
              <code className="font-mono">account_group.read</code> permission.
            </p>
          </Card>
        }
      >
        <AccountGroupList orgId={orgId} />
      </RequirePerm>
    </div>
  );
}
