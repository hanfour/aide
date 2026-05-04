"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@aide/api-types";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const SELECT_CLASS =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

const TEXTAREA_CLASS =
  "flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

const schema = z.object({
  name: z.string().min(1, "Name is required").max(255),
  description: z.string().max(10_000).nullable(),
  rateMultiplier: z.coerce.number().positive().max(10000),
  isExclusive: z.boolean(),
  status: z.enum(["active", "disabled"]),
});

type FormValues = z.infer<typeof schema>;

type Group = inferRouterOutputs<AppRouter>["accountGroups"]["get"];

interface Props {
  orgId: string;
  group: Group;
}

export function AccountGroupEditForm({ orgId, group }: Props) {
  const utils = trpc.useUtils();

  const update = trpc.accountGroups.update.useMutation({
    onSuccess: () => {
      toast.success("Group updated");
      utils.accountGroups.list.invalidate({ orgId });
      utils.accountGroups.get.invalidate({ id: group.id });
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
    formState: { errors, isSubmitting, isDirty },
    reset,
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    values: {
      name: group.name,
      description: group.description ?? "",
      rateMultiplier: Number(group.rateMultiplier),
      isExclusive: group.isExclusive,
      status: group.status === "disabled" ? "disabled" : "active",
    },
  });

  const onSubmit = handleSubmit(async (v) => {
    await update.mutateAsync({
      id: group.id,
      name: v.name,
      description: v.description === "" ? null : v.description,
      rateMultiplier: v.rateMultiplier,
      isExclusive: v.isExclusive,
      status: v.status,
    });
    // Reset dirty state after successful save so the button disables again.
    reset(v);
  });

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="name">Name</Label>
        <Input id="name" {...register("name")} />
        {errors.name && (
          <p className="text-xs text-destructive">{errors.name.message}</p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="description">Description</Label>
        <textarea
          id="description"
          rows={2}
          className={TEXTAREA_CLASS}
          {...register("description")}
        />
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="rateMultiplier">Rate multiplier</Label>
          <Input
            id="rateMultiplier"
            type="number"
            step="0.1"
            min="0"
            {...register("rateMultiplier")}
          />
          {errors.rateMultiplier && (
            <p className="text-xs text-destructive">
              {errors.rateMultiplier.message}
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="status">Status</Label>
          <select id="status" className={SELECT_CLASS} {...register("status")}>
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
          </select>
        </div>

        <div className="space-y-1.5">
          <Label>Exclusive</Label>
          <label className="flex items-start gap-2 pt-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              {...register("isExclusive")}
            />
            <span className="text-xs text-muted-foreground">
              Members not used by other groups
            </span>
          </label>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Platform is fixed at <code className="font-mono">{group.platform}</code>{" "}
        — to change it, delete and recreate the group (members would have to
        re-add anyway since platform mismatch is rejected).
      </p>

      <div className="flex justify-end pt-1">
        <Button
          type="submit"
          disabled={!isDirty || isSubmitting || update.isPending}
        >
          {update.isPending ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
