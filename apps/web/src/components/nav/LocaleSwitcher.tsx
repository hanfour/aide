"use client";

import { useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Languages } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import {
  LOCALES,
  LOCALE_COOKIE,
  LOCALE_LABELS,
  type Locale,
} from "@/i18n/locales";

export function LocaleSwitcher() {
  const current = useLocale() as Locale;
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const t = useTranslations("nav.topbar");

  function pick(locale: Locale) {
    if (locale === current) return;
    // 1 year so the choice survives across sessions; SameSite=Lax matches
    // NextAuth's default. Path "/" so all routes pick up the new cookie
    // on the next request.
    document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`;
    startTransition(() => {
      // Server components re-render with the new cookie value.
      router.refresh();
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          aria-label={t("language")}
          disabled={isPending}
        >
          <Languages className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {t("language")}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {LOCALES.map((l) => (
          <DropdownMenuItem
            key={l}
            onClick={() => pick(l)}
            className={l === current ? "font-medium" : "cursor-pointer"}
          >
            {LOCALE_LABELS[l]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
