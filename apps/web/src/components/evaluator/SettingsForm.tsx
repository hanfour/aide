"use client";

import { useState, useEffect } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// ─── Shared native-element classes (match shadcn Input visually) ──────────────

const SELECT_CLASS =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

// ─── Validation schema ────────────────────────────────────────────────────────

const settingsSchema = z.object({
  contentCaptureEnabled: z.boolean(),
  retentionDaysOverride: z
    .union([z.literal(30), z.literal(60), z.literal(90)])
    .nullable(),
  llmEvalEnabled: z.boolean(),
  llmEvalAccountId: z.string().uuid().nullable(),
  llmEvalModel: z.string().nullable(),
  captureThinking: z.boolean(),
  rubricId: z.string().uuid().nullable(),
  leaderboardEnabled: z.boolean(),
});

type FormValues = z.infer<typeof settingsSchema>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-sm font-semibold text-foreground border-b border-border pb-1">
      {children}
    </h2>
  );
}

function ToggleRow({
  id,
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-0.5">
        <Label htmlFor={id} className="text-sm font-medium cursor-pointer">
          {label}
        </Label>
        {description && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      <button
        type="button"
        id={id}
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={[
          "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent",
          "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          "disabled:cursor-not-allowed disabled:opacity-50",
          checked ? "bg-primary" : "bg-input",
        ].join(" ")}
      >
        <span
          className={[
            "pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform",
            checked ? "translate-x-4" : "translate-x-0",
          ].join(" ")}
        />
      </button>
    </div>
  );
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  orgId: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function SettingsForm({ orgId }: Props) {
  const [wipeOpen, setWipeOpen] = useState(false);
  const utils = trpc.useUtils();

  const { data: settings, isLoading: settingsLoading } =
    trpc.contentCapture.getSettings.useQuery({ orgId });

  const { data: accounts, isLoading: accountsLoading } =
    trpc.accounts.list.useQuery({ orgId });

  const { data: rubrics, isLoading: rubricsLoading } =
    trpc.rubrics.list.useQuery({ orgId });

  const save = trpc.contentCapture.setSettings.useMutation({
    onSuccess: () => {
      toast.success("Settings saved");
      utils.contentCapture.getSettings.invalidate({ orgId });
    },
    onError: (e) => {
      const code = (e.data as { code?: string } | undefined)?.code;
      if (code === "FORBIDDEN") {
        toast.error("Insufficient permission");
      } else {
        toast.error(e.message || "Failed to save settings");
      }
    },
  });

  const wipe = trpc.contentCapture.wipeExistingCaptures.useMutation({
    onSuccess: () => {
      toast.success("Existing captures wiped");
      setWipeOpen(false);
    },
    onError: (e) => {
      const code = (e.data as { code?: string } | undefined)?.code;
      if (code === "FORBIDDEN") {
        toast.error("Insufficient permission");
      } else {
        toast.error(e.message || "Failed to wipe captures");
      }
    },
  });

  const {
    register,
    handleSubmit,
    control,
    reset,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(settingsSchema),
    defaultValues: {
      contentCaptureEnabled: false,
      retentionDaysOverride: null,
      llmEvalEnabled: false,
      llmEvalAccountId: null,
      llmEvalModel: null,
      captureThinking: false,
      rubricId: null,
      leaderboardEnabled: false,
    },
  });

  // Populate form once settings are fetched
  useEffect(() => {
    if (!settings) return;

    const retention = settings.retentionDaysOverride;
    const normalizedRetention =
      retention === 30 || retention === 60 || retention === 90
        ? retention
        : null;

    reset({
      contentCaptureEnabled: settings.contentCaptureEnabled ?? false,
      retentionDaysOverride: normalizedRetention,
      llmEvalEnabled: settings.llmEvalEnabled ?? false,
      llmEvalAccountId: settings.llmEvalAccountId ?? null,
      llmEvalModel: settings.llmEvalModel ?? null,
      captureThinking: settings.captureThinking ?? false,
      rubricId: settings.rubricId ?? null,
      leaderboardEnabled: settings.leaderboardEnabled ?? false,
    });
  }, [settings, reset]);

  const llmEvalEnabled = watch("llmEvalEnabled");

  const onSubmit = handleSubmit((values) => {
    return save.mutateAsync({
      orgId,
      patch: {
        contentCaptureEnabled: values.contentCaptureEnabled,
        retentionDaysOverride: values.retentionDaysOverride,
        llmEvalEnabled: values.llmEvalEnabled,
        llmEvalAccountId: values.llmEvalAccountId,
        llmEvalModel: values.llmEvalModel ?? null,
        captureThinking: values.captureThinking,
        rubricId: values.rubricId,
        leaderboardEnabled: values.leaderboardEnabled,
      },
    });
  });

  if (settingsLoading) {
    return (
      <p className="text-sm text-muted-foreground">Loading settings…</p>
    );
  }

  return (
    <>
      <form onSubmit={onSubmit} className="space-y-8">
        {/* ── Capture section ─────────────────────────────────────────────── */}
        <section className="space-y-4">
          <SectionHeading>Capture</SectionHeading>

          <Controller
            control={control}
            name="contentCaptureEnabled"
            render={({ field }) => (
              <ToggleRow
                id="contentCaptureEnabled"
                label="Enable content capture"
                description="Record request and response bodies for this organization."
                checked={field.value}
                onChange={field.onChange}
              />
            )}
          />

          <div className="space-y-1.5">
            <Label htmlFor="retentionDaysOverride">Retention period</Label>
            <select
              id="retentionDaysOverride"
              className={SELECT_CLASS}
              {...register("retentionDaysOverride", {
                setValueAs: (v) => (v === "" ? null : Number(v)),
              })}
            >
              <option value="">Default (90 days)</option>
              <option value="30">30 days</option>
              <option value="60">60 days</option>
              <option value="90">90 days</option>
            </select>
            {errors.retentionDaysOverride && (
              <p className="text-xs text-destructive">
                {errors.retentionDaysOverride.message}
              </p>
            )}
          </div>
        </section>

        {/* ── LLM Eval section ────────────────────────────────────────────── */}
        <section className="space-y-4">
          <SectionHeading>LLM Evaluation</SectionHeading>

          <Controller
            control={control}
            name="llmEvalEnabled"
            render={({ field }) => (
              <ToggleRow
                id="llmEvalEnabled"
                label="Enable LLM evaluation"
                description="Run automated evaluations on captured requests using an LLM judge."
                checked={field.value}
                onChange={field.onChange}
              />
            )}
          />

          <div className="space-y-1.5">
            <Label htmlFor="llmEvalAccountId">LLM account</Label>
            <select
              id="llmEvalAccountId"
              className={SELECT_CLASS}
              disabled={!llmEvalEnabled || accountsLoading}
              {...register("llmEvalAccountId", {
                setValueAs: (v) => (v === "" ? null : v),
              })}
            >
              {accountsLoading ? (
                <option value="" disabled>
                  Loading accounts…
                </option>
              ) : (
                <option value="">— Select an account —</option>
              )}
              {accounts?.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            {errors.llmEvalAccountId && (
              <p className="text-xs text-destructive">
                {errors.llmEvalAccountId.message}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="llmEvalModel">LLM model</Label>
            <Input
              id="llmEvalModel"
              placeholder="e.g. claude-opus-4-5"
              disabled={!llmEvalEnabled}
              {...register("llmEvalModel", {
                setValueAs: (v) => (v === "" ? null : v),
              })}
            />
            {errors.llmEvalModel && (
              <p className="text-xs text-destructive">
                {errors.llmEvalModel.message}
              </p>
            )}
          </div>

          <Controller
            control={control}
            name="captureThinking"
            render={({ field }) => (
              <ToggleRow
                id="captureThinking"
                label="Capture thinking"
                description="Include extended thinking traces in captured content."
                checked={field.value}
                onChange={field.onChange}
                disabled={!llmEvalEnabled}
              />
            )}
          />
        </section>

        {/* ── Rubric section ──────────────────────────────────────────────── */}
        <section className="space-y-4">
          <SectionHeading>Rubric</SectionHeading>

          <div className="space-y-1.5">
            <Label htmlFor="rubricId">Active rubric</Label>
            <select
              id="rubricId"
              className={SELECT_CLASS}
              disabled={rubricsLoading}
              {...register("rubricId", {
                setValueAs: (v) => (v === "" ? null : v),
              })}
            >
              {rubricsLoading ? (
                <option value="" disabled>
                  Loading rubrics…
                </option>
              ) : (
                <option value="">— None —</option>
              )}
              {rubrics?.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                  {r.isDefault ? " (default)" : ""}
                </option>
              ))}
            </select>
            {errors.rubricId && (
              <p className="text-xs text-destructive">
                {errors.rubricId.message}
              </p>
            )}
          </div>
        </section>

        {/* ── Leaderboard section ─────────────────────────────────────────── */}
        <section className="space-y-4">
          <SectionHeading>Leaderboard</SectionHeading>

          <Controller
            control={control}
            name="leaderboardEnabled"
            render={({ field }) => (
              <ToggleRow
                id="leaderboardEnabled"
                label="Enable leaderboard"
                description="Show an evaluation leaderboard for members of this organization."
                checked={field.value}
                onChange={field.onChange}
              />
            )}
          />
        </section>

        {/* ── Save button ─────────────────────────────────────────────────── */}
        <div className="flex justify-end">
          <Button type="submit" disabled={isSubmitting || save.isPending}>
            {save.isPending ? "Saving…" : "Save settings"}
          </Button>
        </div>

        {/* ── Danger zone ─────────────────────────────────────────────────── */}
        <section className="space-y-4 rounded-lg border border-destructive/40 p-4">
          <SectionHeading>Danger zone</SectionHeading>
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">Wipe existing captures</p>
              <p className="text-xs text-muted-foreground">
                Immediately expire all captured request bodies for this
                organization. This cannot be undone.
              </p>
            </div>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => setWipeOpen(true)}
            >
              Wipe captures
            </Button>
          </div>
        </section>
      </form>

      {/* ── Wipe confirmation dialog ─────────────────────────────────────── */}
      <Dialog open={wipeOpen} onOpenChange={setWipeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Wipe existing captures?</DialogTitle>
            <DialogDescription>
              This will immediately expire all captured request bodies for this
              organization. The data cannot be recovered. Are you sure?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setWipeOpen(false)}
              disabled={wipe.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={wipe.isPending}
              onClick={() => wipe.mutate({ orgId })}
            >
              {wipe.isPending ? "Wiping…" : "Yes, wipe captures"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
