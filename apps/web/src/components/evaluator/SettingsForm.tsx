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

// Native <select> always surfaces an empty string when nothing is chosen.
// Treat "" as null at the form-schema level so react-hook-form's resolver
// doesn't reject the form before submit (the API-side zod still enforces
// uuid/null).
const uuidOrEmpty = z
  .string()
  .nullable()
  .refine((v) => v === null || v === "" || /^[0-9a-f-]{36}$/i.test(v), {
    message: "Invalid id",
  })
  .transform((v) => (v === "" ? null : v));

const settingsSchema = z
  .object({
    contentCaptureEnabled: z.boolean(),
    // Native <select> surfaces "" for the placeholder option even when we
    // register with setValueAs. Accept "" here and let onSubmit coerce it to
    // null — react-hook-form's resolver runs before the setValueAs-transformed
    // value reaches the submit handler in some paths.
    retentionDaysOverride: z
      .union([
        z.literal(30),
        z.literal(60),
        z.literal(90),
        z.literal(""),
        z.null(),
      ])
      .nullable(),
    llmEvalEnabled: z.boolean(),
    llmEvalAccountId: uuidOrEmpty,
    llmEvalModel: z.string().nullable(),
    captureThinking: z.boolean(),
    rubricId: uuidOrEmpty,
    leaderboardEnabled: z.boolean(),
    // ── Plan 4C: cost budget + facet ────────────────────────────────────────
    llmFacetEnabled: z.boolean(),
    llmFacetModel: z
      .enum(["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-7"])
      .nullable(),
    // Native <input type="number"> surfaces "" for empty; coerce to null.
    llmMonthlyBudgetUsd: z.union([z.number(), z.null()]),
    llmBudgetOverageBehavior: z.enum(["degrade", "halt"]),
  })
  .superRefine((val, ctx) => {
    // Plan 4C: facet extraction requires LLM evaluation to be enabled, and a
    // facet model must be chosen. Surface as inline field errors so the user
    // sees them next to the relevant control rather than on submit.
    if (val.llmFacetEnabled && !val.llmEvalEnabled) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Facet extraction requires LLM evaluation to be enabled first",
        path: ["llmFacetEnabled"],
      });
    }
    if (val.llmFacetEnabled && !val.llmFacetModel) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Choose a facet model",
        path: ["llmFacetModel"],
      });
    }
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
    // No client-side resolver. Authoritative validation lives on the tRPC
    // endpoint (apps/api/src/trpc/routers/contentCapture.ts). react-hook-form's
    // zodResolver was blocking submission when select placeholders surfaced ""
    // even though our schema permitted it — clients should never silently drop
    // a save because of a UI-local schema drift.
    defaultValues: {
      contentCaptureEnabled: false,
      retentionDaysOverride: null,
      llmEvalEnabled: false,
      llmEvalAccountId: null,
      llmEvalModel: null,
      captureThinking: false,
      rubricId: null,
      leaderboardEnabled: false,
      // Plan 4C
      llmFacetEnabled: false,
      llmFacetModel: null,
      llmMonthlyBudgetUsd: null,
      llmBudgetOverageBehavior: "degrade",
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

    // Plan 4C — narrow server values to the form's literal-union types.
    // The DB column allows any string, but the UI restricts to a known set.
    const ALLOWED_FACET_MODELS = [
      "claude-haiku-4-5",
      "claude-sonnet-4-6",
      "claude-opus-4-7",
    ] as const;
    type AllowedFacetModel = (typeof ALLOWED_FACET_MODELS)[number];
    const facetModel: AllowedFacetModel | null =
      settings.llmFacetModel != null &&
      (ALLOWED_FACET_MODELS as readonly string[]).includes(
        settings.llmFacetModel,
      )
        ? (settings.llmFacetModel as AllowedFacetModel)
        : null;

    const overage: "degrade" | "halt" =
      settings.llmBudgetOverageBehavior === "halt" ? "halt" : "degrade";

    // Drizzle returns decimal columns as strings.
    const budget =
      settings.llmMonthlyBudgetUsd == null
        ? null
        : Number(settings.llmMonthlyBudgetUsd);

    reset({
      contentCaptureEnabled: settings.contentCaptureEnabled ?? false,
      retentionDaysOverride: normalizedRetention,
      llmEvalEnabled: settings.llmEvalEnabled ?? false,
      llmEvalAccountId: settings.llmEvalAccountId ?? null,
      llmEvalModel: settings.llmEvalModel ?? null,
      captureThinking: settings.captureThinking ?? false,
      rubricId: settings.rubricId ?? null,
      leaderboardEnabled: settings.leaderboardEnabled ?? false,
      // Plan 4C
      llmFacetEnabled: settings.llmFacetEnabled ?? false,
      llmFacetModel: facetModel,
      llmMonthlyBudgetUsd:
        budget != null && Number.isFinite(budget) ? budget : null,
      llmBudgetOverageBehavior: overage,
    });
  }, [settings, reset]);

  const llmEvalEnabled = watch("llmEvalEnabled");

  const onSubmit = handleSubmit((values) => {
    // Empty-string from native <select> placeholders must round-trip to null so
    // the tRPC Zod schema (`z.string().uuid().nullable()`) accepts them.
    const emptyToNull = <T,>(v: T | "" | null | undefined): T | null =>
      v === "" || v === undefined ? null : (v as T);

    // Plan 4C cross-field validation lives in `settingsSchema.superRefine` so
    // errors surface as inline field messages — handleSubmit blocks here when
    // the schema reports issues, so no manual recheck is needed.

    return save.mutateAsync({
      orgId,
      patch: {
        contentCaptureEnabled: values.contentCaptureEnabled,
        // `Number("")` is 0 and `Number(undefined)` is NaN — both surface from
        // the native <select> placeholder even with setValueAs. The server's
        // Zod accepts only 1..365 or null, so coerce anything non-positive.
        retentionDaysOverride:
          typeof values.retentionDaysOverride === "number" &&
          Number.isFinite(values.retentionDaysOverride) &&
          values.retentionDaysOverride > 0
            ? values.retentionDaysOverride
            : null,
        llmEvalEnabled: values.llmEvalEnabled,
        llmEvalAccountId: emptyToNull(values.llmEvalAccountId),
        llmEvalModel: emptyToNull(values.llmEvalModel),
        captureThinking: values.captureThinking,
        rubricId: emptyToNull(values.rubricId),
        leaderboardEnabled: values.leaderboardEnabled,
        // Plan 4C
        llmFacetEnabled: values.llmFacetEnabled,
        llmFacetModel: values.llmFacetModel,
        llmMonthlyBudgetUsd:
          typeof values.llmMonthlyBudgetUsd === "number" &&
          Number.isFinite(values.llmMonthlyBudgetUsd) &&
          values.llmMonthlyBudgetUsd >= 0
            ? values.llmMonthlyBudgetUsd
            : null,
        llmBudgetOverageBehavior: values.llmBudgetOverageBehavior,
      },
    });
  });

  if (settingsLoading) {
    return <p className="text-sm text-muted-foreground">Loading settings…</p>;
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

        {/* ── LLM Cost Control section (Plan 4C) ──────────────────────────── */}
        <section className="space-y-4">
          <SectionHeading>LLM Cost Control</SectionHeading>

          <div className="space-y-1.5">
            <Label htmlFor="llmMonthlyBudgetUsd">Monthly budget (USD)</Label>
            <Input
              id="llmMonthlyBudgetUsd"
              type="number"
              min="0"
              max="100000"
              step="0.01"
              placeholder="Empty = unlimited"
              {...register("llmMonthlyBudgetUsd", {
                setValueAs: (v) => {
                  if (v === "" || v === null || v === undefined) return null;
                  const n = typeof v === "number" ? v : Number(v);
                  return Number.isFinite(n) && n >= 0 ? n : null;
                },
              })}
            />
            <p className="text-xs text-muted-foreground">
              Leave empty to allow unlimited LLM spend. Recommended for
              production: set a budget.
            </p>
            {errors.llmMonthlyBudgetUsd && (
              <p className="text-xs text-destructive">
                {errors.llmMonthlyBudgetUsd.message}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Overage behavior</Label>
            <div className="space-y-1">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  value="degrade"
                  className="mt-0.5"
                  {...register("llmBudgetOverageBehavior")}
                />
                <span>
                  <strong>Degrade</strong> — skip over-budget calls, continue
                  with rule-based scoring
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  value="halt"
                  className="mt-0.5"
                  {...register("llmBudgetOverageBehavior")}
                />
                <span>
                  <strong>Halt</strong> — stop all LLM evaluation for the rest
                  of the month
                </span>
              </label>
            </div>
          </div>

          {settings?.llmHaltedUntilMonthEnd && (
            <p className="text-xs text-amber-700 border border-amber-300 bg-amber-50 rounded px-2 py-1">
              This org is currently halted until next month boundary (UTC).
            </p>
          )}

          {watch("llmEvalEnabled") &&
            (watch("llmMonthlyBudgetUsd") == null ||
              watch("llmMonthlyBudgetUsd") === 0) && (
              <p className="text-xs text-amber-700 border border-amber-300 bg-amber-50 rounded px-2 py-1">
                No budget set. LLM costs are unlimited.
              </p>
            )}
        </section>

        {/* ── LLM Facet Extraction section (Plan 4C) ──────────────────────── */}
        <section className="space-y-4">
          <SectionHeading>LLM Facet Extraction</SectionHeading>

          <Controller
            control={control}
            name="llmFacetEnabled"
            render={({ field }) => (
              <ToggleRow
                id="llmFacetEnabled"
                label="Enable facet extraction"
                description="Adds a per-session LLM classification step to enrich evaluation reports with bug-caught / friction signals. Increases LLM cost; requires LLM evaluation to be enabled."
                checked={field.value}
                onChange={field.onChange}
                disabled={!llmEvalEnabled}
              />
            )}
          />

          <div className="space-y-1.5">
            <Label htmlFor="llmFacetModel">Facet model</Label>
            <Controller
              control={control}
              name="llmFacetModel"
              render={({ field }) => (
                <select
                  id="llmFacetModel"
                  className={SELECT_CLASS}
                  disabled={!watch("llmFacetEnabled")}
                  value={field.value ?? ""}
                  onChange={(e) =>
                    field.onChange(
                      e.target.value === ""
                        ? null
                        : (e.target.value as
                            | "claude-haiku-4-5"
                            | "claude-sonnet-4-6"
                            | "claude-opus-4-7"),
                    )
                  }
                >
                  <option value="">— Select model —</option>
                  <option value="claude-haiku-4-5">
                    claude-haiku-4-5 (recommended)
                  </option>
                  <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
                  <option value="claude-opus-4-7">claude-opus-4-7</option>
                </select>
              )}
            />
            <p className="text-xs text-muted-foreground">
              Haiku is recommended: ~10× cheaper than Sonnet and sufficient for
              structured extraction.
            </p>
          </div>

          {/* Live cross-field hints. Zod's superRefine in `settingsSchema`
              also blocks submit if these conditions hold; these messages are
              for immediate (pre-submit) UX feedback. */}
          {errors.llmFacetEnabled?.message && (
            <p className="text-xs text-destructive">
              {errors.llmFacetEnabled.message}
            </p>
          )}
          {!errors.llmFacetEnabled &&
            watch("llmFacetEnabled") &&
            !llmEvalEnabled && (
              <p className="text-xs text-destructive">
                Facet extraction requires LLM evaluation to be enabled first.
              </p>
            )}
          {errors.llmFacetModel?.message && (
            <p className="text-xs text-destructive">
              {errors.llmFacetModel.message}
            </p>
          )}
          {!errors.llmFacetModel &&
            watch("llmFacetEnabled") &&
            !watch("llmFacetModel") && (
              <p className="text-xs text-destructive">Choose a facet model.</p>
            )}
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
