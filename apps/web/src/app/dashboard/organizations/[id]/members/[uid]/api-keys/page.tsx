"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Plus, ShieldAlert } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { RequirePerm } from "@/components/RequirePerm";
import { AdminIssueDialog } from "@/components/apiKeys/AdminIssueDialog";
import { AdminApiKeyList } from "@/components/apiKeys/AdminApiKeyList";

export default function AdminApiKeysPage() {
  const params = useParams();
  const orgId = params?.id as string;
  const targetUserId = params?.uid as string;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Link
        href={`/dashboard/organizations/${orgId}/members`}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to members
      </Link>

      <RequirePerm
        action={{
          type: "api_key.issue_for_user",
          orgId,
          targetUserId,
        }}
        fallback={
          <Card className="shadow-card flex flex-col items-center p-10 text-center">
            <ShieldAlert className="h-6 w-6 text-muted-foreground" />
            <h3 className="mt-3 text-sm font-semibold">
              You can&apos;t manage this user&apos;s API keys
            </h3>
            <p className="mt-1 max-w-sm text-xs text-muted-foreground">
              Ask a workspace admin for the{" "}
              <code className="font-mono">api_key.issue_for_user</code>{" "}
              permission.
            </p>
          </Card>
        }
      >
        <AdminApiKeysBody orgId={orgId} targetUserId={targetUserId} />
      </RequirePerm>
    </div>
  );
}

function AdminApiKeysBody({
  orgId,
  targetUserId,
}: {
  orgId: string;
  targetUserId: string;
}) {
  const [issueOpen, setIssueOpen] = useState(false);
  const { data: targetUser } = trpc.users.get.useQuery({ id: targetUserId });
  const targetUserLabel = targetUser?.name ?? targetUser?.email ?? "this user";
  const headerLabel = targetUser ? targetUserLabel : "…";

  return (
    <>
      <div className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">
          API keys for {headerLabel}
        </h1>
        <p className="text-sm text-muted-foreground">
          Issue a key for this user. They&apos;ll claim the raw value via a
          one-time URL you share securely.
        </p>
      </div>

      <Card className="shadow-card">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div className="space-y-1">
            <CardTitle className="text-sm font-medium">Issued keys</CardTitle>
            <CardDescription>
              Keys issued by an admin under this organization.
            </CardDescription>
          </div>
          <Button
            size="sm"
            className="gap-1.5"
            onClick={() => setIssueOpen(true)}
          >
            <Plus className="h-4 w-4" />
            Issue new key
          </Button>
        </CardHeader>
        <CardContent>
          <AdminApiKeyList orgId={orgId} targetUserId={targetUserId} />
        </CardContent>
      </Card>

      <AdminIssueDialog
        open={issueOpen}
        onOpenChange={setIssueOpen}
        orgId={orgId}
        targetUserId={targetUserId}
        targetUserLabel={targetUserLabel}
      />
    </>
  );
}
