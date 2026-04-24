"use client";

import { useState } from "react";
import { AlertTriangle, Download } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ExportDialog({ open, onOpenChange }: Props) {
  const [loading, setLoading] = useState(false);
  const utils = trpc.useUtils();

  const handleDownload = async () => {
    try {
      setLoading(true);
      const data = await utils.reports.exportOwn.fetch();

      // Create blob and trigger download
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `evaluation-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);

      toast.success("Export downloaded successfully");
      onOpenChange(false);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Export failed. Please try again.";
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Export My Data</DialogTitle>
          <DialogDescription>
            Download all your evaluation data as a JSON file
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Warning banner */}
          <div className="flex gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/30 dark:bg-amber-900/20">
            <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                Full Data Export
              </p>
              <p className="text-xs text-amber-800 dark:text-amber-300 mt-0.5">
                This will export all evaluation reports and body request metadata
                associated with your account. The file may be large.
              </p>
            </div>
          </div>

          {/* What's included / not included */}
          <div className="space-y-3">
            <div>
              <p className="text-sm font-semibold text-foreground mb-2">
                Included:
              </p>
              <ul className="text-xs text-muted-foreground space-y-1 ml-4">
                <li>• All evaluation reports (scores, narratives, evidence)</li>
                <li>• Body request metadata (capture dates, retention info)</li>
                <li>
                  • Full LLM analysis (you always see your own complete data)
                </li>
              </ul>
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground mb-2">
                Not included:
              </p>
              <ul className="text-xs text-muted-foreground space-y-1 ml-4">
                <li>• Encrypted request body content</li>
                <li className="text-[11px]">
                  (Contact your administrator for decrypted exports)
                </li>
              </ul>
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button
            onClick={handleDownload}
            disabled={loading}
            className="gap-2"
          >
            {loading ? (
              <>
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                Exporting…
              </>
            ) : (
              <>
                <Download className="h-4 w-4" />
                Download
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
