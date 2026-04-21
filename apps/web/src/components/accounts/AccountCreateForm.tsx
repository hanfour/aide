"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Native select/textarea share these classes so they visually match the
// shadcn `Input` primitive — there is no `<Select>` or `<Textarea>` component
// in this app yet (see ui/ directory). Inline-classed natives keep this task
// scoped without inventing new primitives.
const SELECT_CLASS =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

const TEXTAREA_CLASS =
  "flex w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

function isValidJson(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

const schema = z
  .object({
    name: z.string().min(1, "Name is required").max(255),
    platform: z.enum(["anthropic"]),
    type: z.enum(["api_key", "oauth"]),
    scopeType: z.enum(["org", "team"]),
    teamId: z.string().uuid().optional().or(z.literal("")),
    credentials: z.string().min(1, "Credentials are required").max(100_000),
  })
  .refine(
    (v) => v.scopeType === "org" || (v.teamId !== undefined && v.teamId !== ""),
    { message: "Pick a team", path: ["teamId"] },
  )
  .refine((v) => v.type !== "oauth" || isValidJson(v.credentials), {
    message: "OAuth credentials must be valid JSON",
    path: ["credentials"],
  });

type FormValues = z.infer<typeof schema>;

interface Props {
  orgId: string;
}

export function AccountCreateForm({ orgId }: Props) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const { data: teams, isLoading: teamsLoading } = trpc.teams.list.useQuery({
    orgId,
  });

  const create = trpc.accounts.create.useMutation({
    onSuccess: (account) => {
      toast.success(`Account "${account?.name}" created`);
      utils.accounts.list.invalidate({ orgId });
      router.push(`/dashboard/organizations/${orgId}/accounts`);
    },
    onError: (e) => {
      const code = (e.data as { code?: string } | undefined)?.code;
      if (code === "FORBIDDEN") {
        toast.error("Insufficient permission");
      } else if (code === "BAD_REQUEST") {
        toast.error(e.message || "Invalid request");
      } else {
        toast.error(e.message);
      }
    },
  });

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      platform: "anthropic",
      type: "api_key",
      scopeType: "org",
    },
  });

  const type = watch("type");
  const scopeType = watch("scopeType");

  const credentialHint =
    type === "oauth"
      ? "Paste the OAuth JSON returned by `claude auth login` — must include `access_token`, `refresh_token`, `expires_at`."
      : "Paste the raw Anthropic API key (sk-ant-...).";

  const onSubmit = handleSubmit((v) =>
    create.mutateAsync({
      orgId,
      teamId: v.scopeType === "team" ? v.teamId || undefined : null,
      name: v.name,
      platform: v.platform,
      type: v.type,
      credentials: v.credentials,
    }),
  );

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="name">Name</Label>
        <Input
          id="name"
          placeholder="e.g. Production Anthropic key"
          {...register("name")}
        />
        {errors.name && (
          <p className="text-xs text-destructive">{errors.name.message}</p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="platform">Platform</Label>
        <select id="platform" className={SELECT_CLASS} {...register("platform")}>
          <option value="anthropic">Anthropic</option>
        </select>
        <p className="text-xs text-muted-foreground">
          Only Anthropic is supported today.
        </p>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium leading-none">Type</legend>
        <div className="flex flex-col gap-2 pt-1">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              value="api_key"
              className="mt-0.5"
              {...register("type")}
            />
            <span>
              <span className="font-medium">API key</span>
              <span className="block text-xs text-muted-foreground">
                Long-lived Anthropic API key.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              value="oauth"
              className="mt-0.5"
              {...register("type")}
            />
            <span>
              <span className="font-medium">OAuth (JSON)</span>
              <span className="block text-xs text-muted-foreground">
                Refreshable token bundle from `claude auth login`.
              </span>
            </span>
          </label>
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium leading-none">Scope</legend>
        <div className="flex flex-col gap-2 pt-1">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              value="org"
              className="mt-0.5"
              {...register("scopeType")}
            />
            <span>
              <span className="font-medium">Organization</span>
              <span className="block text-xs text-muted-foreground">
                Any team in this workspace can use this account.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              value="team"
              className="mt-0.5"
              {...register("scopeType")}
            />
            <span>
              <span className="font-medium">Specific team</span>
              <span className="block text-xs text-muted-foreground">
                Only the selected team can use this account.
              </span>
            </span>
          </label>
        </div>
        {scopeType === "team" && (
          <div className="space-y-1.5 pl-6 pt-1">
            <Label htmlFor="teamId">Team</Label>
            <select
              id="teamId"
              className={SELECT_CLASS}
              disabled={teamsLoading}
              {...register("teamId")}
            >
              <option value="">— Select a team —</option>
              {teams?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            {errors.teamId && (
              <p className="text-xs text-destructive">{errors.teamId.message}</p>
            )}
          </div>
        )}
      </fieldset>

      <div className="space-y-1.5">
        <Label htmlFor="credentials">Credentials</Label>
        <textarea
          id="credentials"
          rows={6}
          className={TEXTAREA_CLASS}
          placeholder={
            type === "oauth"
              ? '{"access_token":"...","refresh_token":"...","expires_at":...}'
              : "sk-ant-..."
          }
          {...register("credentials")}
        />
        <p className="text-xs text-muted-foreground">{credentialHint}</p>
        {errors.credentials && (
          <p className="text-xs text-destructive">
            {errors.credentials.message}
          </p>
        )}
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="outline" asChild>
          <Link href={`/dashboard/organizations/${orgId}/accounts`}>Cancel</Link>
        </Button>
        <Button type="submit" disabled={isSubmitting || create.isPending}>
          {create.isPending ? "Creating…" : "Create account"}
        </Button>
      </div>
    </form>
  );
}
