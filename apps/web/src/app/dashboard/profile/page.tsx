"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { BarChart3 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { ApiKeyList } from "@/components/apiKeys/ApiKeyList";

const schema = z.object({
  name: z.string().min(1).max(255).optional(),
  image: z.string().url().max(1024).optional().or(z.literal("")),
});

type FormValues = z.infer<typeof schema>;

export default function ProfilePage() {
  const { data: session, refetch } = trpc.me.session.useQuery();
  const { data: disclosure } = trpc.me.captureDisclosure.useQuery();
  const update = trpc.me.updateProfile.useMutation({
    onSuccess: () => {
      toast.success("Profile updated");
      refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  const {
    register,
    handleSubmit,
    reset,
    formState: { isSubmitting, errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
  });

  useEffect(() => {
    if (session?.user) {
      // placeholder; me.session returns user id/email but updateProfile works against users table
      reset({ name: "", image: "" });
    }
  }, [session, reset]);

  if (!session?.user) {
    return (
      <Card className="shadow-card p-6 text-sm text-muted-foreground">
        Loading…
      </Card>
    );
  }

  const hasEvaluationEnabled = (disclosure ?? []).length > 0;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Profile</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage how you appear across the workspace.
        </p>
      </div>

      {/* Evaluation banner — only shown when contentCapture is on for at least one of the user's orgs */}
      {hasEvaluationEnabled && (
        <div className="rounded-lg border bg-sky-50 dark:bg-sky-950/30 border-sky-200 dark:border-sky-900 p-4 mb-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-medium text-sky-900 dark:text-sky-100">
                Evaluation is enabled
              </h3>
              <p className="text-sm text-sky-800 dark:text-sky-200 mt-1">
                Your AI-assisted development activity is being evaluated. View
                your transparency report below.
              </p>
            </div>
            <Link
              href="/dashboard/profile/evaluation"
              className="shrink-0 text-sm font-medium text-sky-700 hover:text-sky-900 dark:text-sky-300 dark:hover:text-sky-100 underline"
            >
              View my reports →
            </Link>
          </div>
        </div>
      )}

      <Card className="shadow-card">
        <CardHeader className="flex flex-row items-center gap-4">
          <Avatar className="h-14 w-14">
            <AvatarFallback className="bg-primary text-primary-foreground">
              {session.user.email.charAt(0).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div>
            <CardTitle>{session.user.email}</CardTitle>
            <CardDescription>Signed in via OAuth provider</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={handleSubmit((v) =>
              update.mutateAsync({
                name: v.name || undefined,
                image: v.image || undefined,
              }),
            )}
            className="space-y-4"
          >
            <div className="space-y-1.5">
              <Label htmlFor="name">Display name</Label>
              <Input id="name" {...register("name")} placeholder="Jane Doe" />
              {errors.name && (
                <p className="text-xs text-destructive">
                  {errors.name.message}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="image">Profile picture URL</Label>
              <Input
                id="image"
                {...register("image")}
                placeholder="https://…"
              />
              {errors.image && (
                <p className="text-xs text-destructive">
                  {errors.image.message}
                </p>
              )}
            </div>
            <div className="flex justify-end">
              <Button type="submit" disabled={isSubmitting || update.isPending}>
                {update.isPending ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card className="shadow-card">
        <CardHeader>
          <CardTitle className="text-sm font-medium">Your roles</CardTitle>
        </CardHeader>
        <CardContent>
          {session.assignments.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active roles.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {session.assignments.map(
                (a: {
                  id: string;
                  role: string;
                  scopeType: string;
                  scopeId: string | null;
                }) => (
                  <Badge
                    key={a.id}
                    variant="secondary"
                    className="rounded-md font-normal"
                  >
                    {a.role}
                    <span className="mx-1 text-muted-foreground">@</span>
                    <span className="text-muted-foreground">{a.scopeType}</span>
                  </Badge>
                ),
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          API keys authenticate your CLI / scripts to the gateway. Treat them
          like passwords.
        </p>
        <Link
          href="/dashboard/profile/usage"
          className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <BarChart3 className="h-3.5 w-3.5" />
          View usage
        </Link>
      </div>
      <ApiKeyList />
    </div>
  );
}
