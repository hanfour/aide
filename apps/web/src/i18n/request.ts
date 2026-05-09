import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_COOKIE,
  isLocale,
  type Locale,
} from "./locales";

/**
 * Resolve the active locale per request:
 *   1. user-set cookie (`NEXT_LOCALE`) — highest priority
 *   2. `Accept-Language` header — best match against shipped locales
 *   3. `DEFAULT_LOCALE` fallback
 *
 * URL-based routing (`/[locale]/...`) was deliberately avoided — every
 * existing path/bookmark continues to resolve and only the rendered
 * strings change.
 */
function pickFromAcceptLanguage(headerValue: string | null): Locale | null {
  if (!headerValue) return null;
  // Parse "zh-TW,zh;q=0.9,en;q=0.8" → ["zh-TW","zh","en"] in priority order.
  const tags = headerValue
    .split(",")
    .map((part) => part.split(";")[0]?.trim())
    .filter((t): t is string => Boolean(t));
  for (const tag of tags) {
    if (isLocale(tag)) return tag;
    // Also try the primary subtag (e.g. "zh" → match "zh-TW" first).
    const primary = tag.split("-")[0];
    if (!primary) continue;
    const fallback = LOCALES.find(
      (l) => l.startsWith(primary + "-") || l === primary,
    );
    if (fallback) return fallback;
  }
  return null;
}

export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const fromCookie = cookieStore.get(LOCALE_COOKIE)?.value;
  if (isLocale(fromCookie)) {
    return {
      locale: fromCookie,
      messages: (await import(`../../messages/${fromCookie}.json`)).default,
    };
  }
  const headerStore = await headers();
  const fromAccept = pickFromAcceptLanguage(headerStore.get("accept-language"));
  const locale: Locale = fromAccept ?? DEFAULT_LOCALE;
  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
