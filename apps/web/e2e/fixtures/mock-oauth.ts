/**
 * Mock the Auth.js OAuth flow without touching real providers.
 *
 * Auth.js v5 (next-auth 5.0.0-beta) uses database sessions here. The session
 * cookie value is the sessionToken column of the `sessions` table. Seed a
 * row via /test-seed, then set the cookie directly on the browser context —
 * Auth.js validates the token against the DB on the next request.
 *
 * Cookie name: `authjs.session-token` in http dev, `__Secure-authjs.session-token`
 * over https. We always test over http://localhost so we use the plain name.
 */
import type { BrowserContext } from "@playwright/test";

const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3000);
const BASE_URL = `http://localhost:${WEB_PORT}`;

export const SESSION_COOKIE_NAME = "authjs.session-token";

export interface SignInOpts {
  sessionToken: string;
}

export async function signInWithSession(
  context: BrowserContext,
  opts: SignInOpts,
): Promise<void> {
  const url = new URL(BASE_URL);
  await context.addCookies([
    {
      name: SESSION_COOKIE_NAME,
      value: opts.sessionToken,
      domain: url.hostname,
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ]);
}

export async function signOut(context: BrowserContext): Promise<void> {
  await context.clearCookies({ name: SESSION_COOKIE_NAME });
}
