import Google from "next-auth/providers/google";
import GitHub from "next-auth/providers/github";
import type { Provider } from "next-auth/providers";

export interface ProviderEnv {
  GOOGLE_CLIENT_ID?: string | undefined;
  GOOGLE_CLIENT_SECRET?: string | undefined;
  GITHUB_CLIENT_ID?: string | undefined;
  GITHUB_CLIENT_SECRET?: string | undefined;
}

/**
 * Build the OAuth provider list from env. A provider is registered only when
 * BOTH its id and secret are non-empty — operators can ship Google-only,
 * GitHub-only, or both. The env schema enforces "at least one provider"
 * upstream, so this function never legitimately returns an empty array
 * during boot, but defensive callers should still verify.
 */
export function buildProviders(env: ProviderEnv): Provider[] {
  const providers: Provider[] = [];
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    providers.push(
      Google({
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        allowDangerousEmailAccountLinking: false,
      }),
    );
  }
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    providers.push(
      GitHub({
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
        allowDangerousEmailAccountLinking: false,
      }),
    );
  }
  return providers;
}

/**
 * Inspect-only helper for the sign-in UI: returns which provider buttons
 * should be rendered based on the same creds-non-empty rule as
 * `buildProviders`. Keep the two in lockstep when adding a provider.
 */
export function configuredProviderIds(env: ProviderEnv): Array<"google" | "github"> {
  const ids: Array<"google" | "github"> = [];
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) ids.push("google");
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) ids.push("github");
  return ids;
}
