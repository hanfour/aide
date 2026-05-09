"use client";

import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { ShieldAlert } from "lucide-react";
import { Card } from "@/components/ui/card";
import { RequirePerm } from "@/components/RequirePerm";
import { AccountGroupList } from "@/components/accountGroups/AccountGroupList";

export default function AccountGroupsPage() {
  const params = useParams();
  const orgId = params?.id as string;
  const t = useTranslations("accountGroups");
  const tPage = useTranslations("accountGroupsPage");

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold tracking-tight">{t("title")}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("subtitle")}
        </p>
      </div>

      <RequirePerm
        action={{ type: "account_group.read", orgId }}
        fallback={
          <Card className="shadow-card flex flex-col items-center p-10 text-center">
            <ShieldAlert className="h-6 w-6 text-muted-foreground" />
            <h3 className="mt-3 text-sm font-semibold">
              {tPage("cantViewTitle")}
            </h3>
            <p className="mt-1 max-w-sm text-xs text-muted-foreground">
              {tPage.rich("cantViewHint", {
                code: (chunks) => <code className="font-mono">{chunks}</code>
              })}
            </p>
          </Card>
        }
      >
        <AccountGroupList orgId={orgId} />
      </RequirePerm>
    </div>
  );
}
