"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@aide/api-types";
import { rubricSchema } from "@aide/evaluator";
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

// ─── Types ────────────────────────────────────────────────────────────────────

type RubricRow = inferRouterOutputs<AppRouter>["rubrics"]["list"][number];

// ─── Shared class strings ─────────────────────────────────────────────────────

const TEXTAREA_CLASS =
  "flex min-h-[200px] w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

// ─── Validation ───────────────────────────────────────────────────────────────

const formSchema = z.object({
  name: z.string().min(1, "Name is required").max(200),
  description: z.string().max(1000).optional(),
  version: z.string().min(1, "Version is required").max(50),
  definitionJson: z
    .string()
    .min(1, "Definition is required")
    .superRefine((val, ctx) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(val);
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Must be valid JSON" });
        return;
      }
      const result = rubricSchema.safeParse(parsed);
      if (!result.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid rubric definition: ${result.error.issues.map((i) => i.message).join("; ")}`,
        });
      }
    }),
});

type FormValues = z.infer<typeof formSchema>;

// ─── Props ────────────────────────────────────────────────────────────────────

interface RubricEditorProps {
  orgId: string;
  editingRow: RubricRow | null;
  onSuccess: () => void;
  onCancel: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tryFormatJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export function RubricEditor({ orgId, editingRow, onSuccess, onCancel }: RubricEditorProps) {
  const isEditing = editingRow !== null;
  const [uploadError, setUploadError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      description: "",
      version: "1.0.0",
      definitionJson: "",
    },
  });

  // Populate form when editing an existing rubric
  const { data: existingRubric } = trpc.rubrics.get.useQuery(
    { rubricId: editingRow?.id ?? "" },
    { enabled: isEditing && editingRow !== null },
  );

  useEffect(() => {
    if (!existingRubric) return;
    reset({
      name: existingRubric.name,
      description: existingRubric.description ?? "",
      version: existingRubric.version,
      definitionJson: existingRubric.definition
        ? JSON.stringify(existingRubric.definition, null, 2)
        : "",
    });
  }, [existingRubric, reset]);

  const create = trpc.rubrics.create.useMutation({
    onSuccess: () => {
      toast.success("Rubric created");
      onSuccess();
    },
    onError: (e) => {
      const code = (e.data as { code?: string } | undefined)?.code;
      if (code === "FORBIDDEN") {
        toast.error("Insufficient permission");
      } else {
        toast.error(e.message || "Failed to create rubric");
      }
    },
  });

  const update = trpc.rubrics.update.useMutation({
    onSuccess: () => {
      toast.success("Rubric updated");
      onSuccess();
    },
    onError: (e) => {
      const code = (e.data as { code?: string } | undefined)?.code;
      if (code === "FORBIDDEN") {
        toast.error("Insufficient permission");
      } else {
        toast.error(e.message || "Failed to update rubric");
      }
    },
  });

  const onSubmit = handleSubmit((values) => {
    const definition = JSON.parse(values.definitionJson) as unknown;
    if (isEditing && editingRow) {
      return update.mutateAsync({
        rubricId: editingRow.id,
        orgId,
        patch: {
          name: values.name,
          description: values.description || null,
          version: values.version,
          definition,
        },
      });
    }
    return create.mutateAsync({
      orgId,
      name: values.name,
      description: values.description || undefined,
      version: values.version,
      definition,
    });
  });

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    setUploadError(null);
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result;
      if (typeof text !== "string") return;
      const formatted = tryFormatJson(text);
      setValue("definitionJson", formatted, { shouldValidate: false });
    };
    reader.onerror = () => {
      setUploadError("Failed to read file");
    };
    reader.readAsText(file);
    // Reset the input so re-uploading the same file fires the event
    e.target.value = "";
  };

  const isMutating = create.isPending || update.isPending;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit rubric" : "New rubric"}</DialogTitle>
          <DialogDescription>
            {isEditing
              ? "Update this rubric's metadata or definition."
              : "Define a custom scoring rubric for your organization."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          {/* Name */}
          <div className="space-y-1.5">
            <Label htmlFor="rubric-name">Name</Label>
            <Input
              id="rubric-name"
              placeholder="e.g. Engineering Excellence"
              {...register("name")}
            />
            {errors.name && (
              <p className="text-xs text-destructive">{errors.name.message}</p>
            )}
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <Label htmlFor="rubric-description">Description</Label>
            <Input
              id="rubric-description"
              placeholder="Optional summary"
              {...register("description")}
            />
            {errors.description && (
              <p className="text-xs text-destructive">{errors.description.message}</p>
            )}
          </div>

          {/* Version */}
          <div className="space-y-1.5">
            <Label htmlFor="rubric-version">Version</Label>
            <Input
              id="rubric-version"
              placeholder="e.g. 1.0.0"
              {...register("version")}
            />
            {errors.version && (
              <p className="text-xs text-destructive">{errors.version.message}</p>
            )}
          </div>

          {/* Definition — file upload or manual JSON */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="rubric-definition">Definition (JSON)</Label>
              <label
                htmlFor="rubric-file-upload"
                className="cursor-pointer text-xs text-primary underline-offset-2 hover:underline"
              >
                Upload JSON file
                <input
                  id="rubric-file-upload"
                  type="file"
                  accept=".json,application/json"
                  className="sr-only"
                  onChange={handleFileUpload}
                />
              </label>
            </div>
            <textarea
              id="rubric-definition"
              className={TEXTAREA_CLASS}
              placeholder={'{\n  "name": "...",\n  "version": "1.0.0",\n  "sections": [...]\n}'}
              spellCheck={false}
              {...register("definitionJson")}
            />
            {uploadError && (
              <p className="text-xs text-destructive">{uploadError}</p>
            )}
            {errors.definitionJson && (
              <p className="text-xs text-destructive">{errors.definitionJson.message}</p>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel} disabled={isMutating}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting || isMutating}>
              {isMutating
                ? isEditing ? "Saving…" : "Creating…"
                : isEditing ? "Save changes" : "Create rubric"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
