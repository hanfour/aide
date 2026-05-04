"use client";

import { useParams } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { Card } from "@/components/ui/card";
import { RequirePerm } from "@/components/RequirePerm";
import { AccountGroupDetail } from "@/components/accountGroups/AccountGroupDetail";

export default function AccountGroupDetailPage() {
  const params = useParams();
  const orgId = params?.id as string;
  const groupId = params?.gid as string;

  return (
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
      <AccountGroupDetail orgId={orgId} groupId={groupId} />
    </RequirePerm>
  );
}
