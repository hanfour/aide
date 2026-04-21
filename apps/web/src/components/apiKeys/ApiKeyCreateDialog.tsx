"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { AlertTriangle, Copy } from "lucide-react";
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

const schema = z.object({
  name: z.string().min(1, "Name is required").max(255),
});

type FormValues = z.infer<typeof schema>;

interface Revealed {
  raw: string;
  prefix: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ApiKeyCreateDialog({ open, onOpenChange }: Props) {
  const utils = trpc.useUtils();
  // The raw key lives ONLY in component state. It is never logged, never sent
  // to a toast string, and never persisted. Closing the dialog drops it.
  const [revealed, setRevealed] = useState<Revealed | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: "" },
  });

  // Whenever the dialog closes (Cancel, X, ESC, click-outside), reset BOTH
  // the form and the revealed key so the next open starts clean. This is the
  // intentional one-time-reveal contract — there is no "undo".
  useEffect(() => {
    if (!open) {
      setRevealed(null);
      reset({ name: "" });
    }
  }, [open, reset]);

  const issue = trpc.apiKeys.issueOwn.useMutation({
    onSuccess: ({ raw, prefix }) => {
      // Hold raw in state for the reveal panel; do NOT echo it elsewhere.
      setRevealed({ raw, prefix });
      utils.apiKeys.listOwn.invalidate();
    },
    onError: (e) => {
      const code = (e.data as { code?: string } | undefined)?.code;
      toast.error(code === "FORBIDDEN" ? "Insufficient permission" : e.message);
    },
  });

  const handleCopy = async () => {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed.raw);
      // Toast text intentionally does NOT include the raw value.
      toast.success("Copied");
    } catch {
      toast.error("Clipboard unavailable");
    }
  };

  const onSubmit = (values: FormValues) => {
    return issue.mutateAsync({ name: values.name });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {revealed ? (
          <>
            <DialogHeader>
              <DialogTitle>API key created</DialogTitle>
              <DialogDescription>
                Copy this key now. You won&apos;t be able to see it again.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div
                role="alert"
                className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>Save this key now. We can&apos;t show it again.</span>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="apiKeyRaw">Key</Label>
                <div className="flex items-stretch gap-2">
                  <code
                    id="apiKeyRaw"
                    className="flex-1 select-all break-all rounded-md border border-input bg-muted/50 px-3 py-2 font-mono text-xs"
                  >
                    {revealed.raw}
                  </code>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleCopy}
                    className="gap-1.5"
                    aria-label="Copy key to clipboard"
                  >
                    <Copy className="h-4 w-4" />
                    Copy
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Prefix:{" "}
                <code className="font-mono text-foreground">
                  {revealed.prefix}
                </code>
              </p>
            </div>
            <DialogFooter>
              <Button type="button" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>New API key</DialogTitle>
              <DialogDescription>
                Generate a key to authenticate the AIDE gateway from your CLI or
                scripts.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="apiKeyName">Name</Label>
                <Input
                  id="apiKeyName"
                  placeholder="e.g. Laptop CLI"
                  autoComplete="off"
                  {...register("name")}
                />
                {errors.name && (
                  <p className="text-xs text-destructive">
                    {errors.name.message}
                  </p>
                )}
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={issue.isPending}>
                  {issue.isPending ? "Generating…" : "Generate key"}
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
