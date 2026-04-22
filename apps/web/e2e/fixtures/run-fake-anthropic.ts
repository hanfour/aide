/**
 * Standalone entrypoint that boots the fake Anthropic upstream on a fixed
 * port. Used by Playwright's `webServer` and by CI.
 *
 * Run with: `node --import tsx run-fake-anthropic.ts`
 *   (or via `pnpm exec tsx run-fake-anthropic.ts`)
 *
 * Reads FAKE_ANTHROPIC_PORT from the env and falls back to the shared
 * default (4100) defined in gateway-env.ts. Stays alive until SIGTERM/SIGINT.
 */

import { startFakeAnthropic } from "./fake-anthropic.js";
import { E2E_FAKE_ANTHROPIC_PORT } from "./gateway-env.js";

async function main(): Promise<void> {
  const port = Number(process.env.FAKE_ANTHROPIC_PORT ?? E2E_FAKE_ANTHROPIC_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid FAKE_ANTHROPIC_PORT: ${process.env.FAKE_ANTHROPIC_PORT}`);
  }

  const fake = await startFakeAnthropic({ port });
  // eslint-disable-next-line no-console
  console.log(`[fake-anthropic] listening on ${fake.url}`);

  const shutdown = (signal: string): void => {
    // eslint-disable-next-line no-console
    console.log(`[fake-anthropic] received ${signal}, closing…`);
    fake
      .close()
      .then(() => process.exit(0))
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[fake-anthropic] close failed", err);
        process.exit(1);
      });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[fake-anthropic] fatal", err);
  process.exit(1);
});
