"use client";

import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface DeleteRequestDialogProps {
  orgId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Scope = "bodies" | "bodies_and_reports";

interface SuccessState {
  type: "success";
}

interface FormState {
  type: "form";
  scope: Scope;
  reason: string;
}

type DialogState = FormState | SuccessState;

export function DeleteRequestDialog({
  orgId,
  open,
  onOpenChange,
}: DeleteRequestDialogProps) {
  const [dialogState, setDialogState] = useState<DialogState>({
    type: "form",
    scope: "bodies",
    reason: "",
  });

  const deleteOwn = trpc.reports.deleteOwn.useMutation();

  const isLoading = deleteOwn.isPending;
  const isSuccess = dialogState.type === "success";

  const handleScopeChange = (newScope: Scope) => {
    if (dialogState.type === "form") {
      setDialogState({ ...dialogState, scope: newScope });
    }
  };

  const handleReasonChange = (newReason: string) => {
    if (dialogState.type === "form" && newReason.length <= 1000) {
      setDialogState({ ...dialogState, reason: newReason });
    }
  };

  const handleSubmit = async () => {
    if (dialogState.type !== "form") return;

    try {
      await deleteOwn.mutateAsync({
        orgId,
        scope: dialogState.scope,
        reason: dialogState.reason || undefined,
      });

      setDialogState({ type: "success" });

      const timer = setTimeout(() => {
        onOpenChange(false);
        setDialogState({
          type: "form",
          scope: "bodies",
          reason: "",
        });
      }, 3000);

      return () => clearTimeout(timer);
    } catch (error) {
      // Error is handled by mutation state, user sees it via toast/UI
    }
  };

  const handleClose = () => {
    if (isSuccess) {
      onOpenChange(false);
      setDialogState({
        type: "form",
        scope: "bodies",
        reason: "",
      });
    } else {
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        {isSuccess ? (
          <>
            <DialogHeader>
              <DialogTitle>Request Submitted</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Your deletion request has been submitted successfully. Your
                organization administrator will review this request and notify
                you of the outcome.
              </p>
              <Button
                onClick={handleClose}
                className="w-full"
                variant="default"
              >
                Close
              </Button>
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Request Data Deletion</DialogTitle>
              <DialogDescription>
                Submit a GDPR data deletion request for your account. Your
                organization administrator must review and approve this request.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-5">
              {/* Scope radio group */}
              <div className="space-y-3">
                <label className="text-sm font-medium">
                  What would you like to delete?
                </label>
                <div className="space-y-2.5">
                  <label className="flex items-start gap-3 cursor-pointer rounded-lg border border-border p-3 hover:bg-accent/30 transition-colors">
                    <input
                      type="radio"
                      name="scope"
                      value="bodies"
                      checked={dialogState.scope === "bodies"}
                      onChange={(e) =>
                        handleScopeChange(e.target.value as Scope)
                      }
                      className="mt-1 h-4 w-4 cursor-pointer"
                    />
                    <div className="flex-1">
                      <p className="text-sm font-medium">
                        Delete captured conversations only
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Your API request bodies will be deleted. Evaluation
                        reports will be retained for historical records.
                      </p>
                    </div>
                  </label>

                  <label className="flex items-start gap-3 cursor-pointer rounded-lg border border-border p-3 hover:bg-accent/30 transition-colors">
                    <input
                      type="radio"
                      name="scope"
                      value="bodies_and_reports"
                      checked={dialogState.scope === "bodies_and_reports"}
                      onChange={(e) =>
                        handleScopeChange(e.target.value as Scope)
                      }
                      className="mt-1 h-4 w-4 cursor-pointer"
                    />
                    <div className="flex-1">
                      <p className="text-sm font-medium">
                        Delete conversations and evaluation reports
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Both your API request bodies and evaluation reports will
                        be deleted completely.
                      </p>
                    </div>
                  </label>
                </div>
              </div>

              {/* Reason textarea */}
              <div className="space-y-2">
                <label htmlFor="reason" className="text-sm font-medium">
                  Reason for deletion (optional)
                </label>
                <textarea
                  id="reason"
                  placeholder="Please provide any context for your deletion request (e.g., employment separation, data concerns)…"
                  value={dialogState.reason}
                  onChange={(e) => handleReasonChange(e.target.value)}
                  maxLength={1000}
                  rows={3}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                />
                <p className="text-xs text-muted-foreground text-right">
                  {dialogState.reason.length}/1000
                </p>
              </div>

              {/* Disclaimer */}
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/50 dark:bg-amber-950/20">
                <div className="flex gap-3">
                  <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                  <p className="text-xs text-amber-800 dark:text-amber-200">
                    Your request will be reviewed by your organization
                    administrator. It may be approved or rejected. You will be
                    notified of the outcome.
                  </p>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="flex gap-2 justify-end pt-2">
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isLoading}
              >
                Cancel
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={isLoading}
                className="gap-2"
              >
                {isLoading ? (
                  <>
                    <span className="h-4 w-4 inline-block animate-spin rounded-full border-2 border-current border-t-transparent" />
                    Submitting…
                  </>
                ) : (
                  "Request Deletion"
                )}
              </Button>
            </div>

            {deleteOwn.error && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                <p className="text-xs text-destructive">
                  {deleteOwn.error.message ||
                    "Failed to submit deletion request"}
                </p>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
