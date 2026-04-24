"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, ShieldAlert } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { Card } from "@/components/ui/card";
import { RequirePerm } from "@/components/RequirePerm";
import { TeamAggregate } from "@/components/evaluator/TeamAggregate";
import { TeamLeaderboard } from "@/components/evaluator/TeamLeaderboard";

export default function TeamEvaluatorPage() {
  const params = useParams();
  const orgId = params?.id as string;
  const teamId = params?.tid as string;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Link
        href={`/dashboard/organizations/${orgId}/teams`}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to teams
      </Link>

      <RequirePerm
        action={{ type: "report.read_team", orgId, teamId }}
        fallback={
          <Card className="shadow-card flex flex-col items-center p-10 text-center">
            <ShieldAlert className="h-6 w-6 text-muted-foreground" />
            <h3 className="mt-3 text-sm font-semibold">
              You don&apos;t have access to this team&apos;s reports
            </h3>
            <p className="mt-1 max-w-sm text-xs text-muted-foreground">
              Ask a workspace admin for the{" "}
              <code className="font-mono">report.read_team</code> permission.
            </p>
          </Card>
        }
      >
        <TeamEvaluatorBody orgId={orgId} teamId={teamId} />
      </RequirePerm>
    </div>
  );
}

function TeamEvaluatorBody({
  orgId,
  teamId,
}: {
  orgId: string;
  teamId: string;
}) {
  const { data: team, isLoading: teamLoading } = trpc.teams.get.useQuery({
    id: teamId,
  });
  const { data: members, isLoading: membersLoading } =
    trpc.users.list.useQuery({ teamId });

  const teamName = teamLoading ? "…" : (team?.name ?? "Team");

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{teamName}</h1>
        {team?.slug && (
          <p className="mt-0.5 text-xs text-muted-foreground">/{team.slug}</p>
        )}
      </div>

      {/* Team aggregate + 30-day trend */}
      <TeamAggregate orgId={orgId} teamId={teamId} teamName={teamName} />

      {/* Member leaderboard / score list */}
      {!membersLoading && members && (
        <TeamLeaderboard orgId={orgId} teamId={teamId} members={members} />
      )}
      {membersLoading && (
        <Card>
          <div className="py-8 text-center text-sm text-muted-foreground">
            Loading members…
          </div>
        </Card>
      )}
    </div>
  );
}
