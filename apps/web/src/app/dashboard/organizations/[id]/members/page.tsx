"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { KeyRound, ShieldAlert, Users } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { Card } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { RequirePerm } from "@/components/RequirePerm";

export default function MembersTab() {
  const params = useParams();
  const orgId = params?.id as string;
  const {
    data: members,
    isLoading,
    error,
  } = trpc.users.list.useQuery({ orgId });

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
        <h3 className="mt-3 text-sm font-semibold">Unable to load members</h3>
        <p className="mt-1 max-w-sm text-xs text-muted-foreground">
          {error.message}
        </p>
      </Card>
    );
  }

  if (!members || members.length === 0) {
    return (
      <Card className="shadow-card flex flex-col items-center p-10 text-center">
        <Users className="h-6 w-6 text-muted-foreground" />
        <h3 className="mt-3 text-sm font-semibold">No members yet</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Invite teammates from the Invites tab.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {members.length} {members.length === 1 ? "member" : "members"}
      </p>
      <Card className="shadow-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
              <th className="px-4 py-2 text-left font-medium">Member</th>
              <th className="px-4 py-2 text-left font-medium">Joined</th>
              <th className="px-4 py-2 text-right font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr
                key={m.id}
                className="border-b border-border last:border-0 hover:bg-accent/20"
              >
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-3">
                    <Avatar className="h-8 w-8">
                      <AvatarFallback className="bg-primary/10 text-xs text-primary">
                        {m.email.charAt(0).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <div className="font-medium">{m.name ?? m.email}</div>
                      <div className="text-xs text-muted-foreground">
                        {m.email}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-2.5 text-xs text-muted-foreground">
                  {new Date(m.createdAt).toLocaleDateString()}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <RequirePerm
                    action={{
                      type: "api_key.issue_for_user",
                      orgId,
                      targetUserId: m.id,
                    }}
                  >
                    <Link
                      href={`/dashboard/organizations/${orgId}/members/${m.id}/api-keys`}
                      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                      <KeyRound className="h-3.5 w-3.5" />
                      API keys
                    </Link>
                  </RequirePerm>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
