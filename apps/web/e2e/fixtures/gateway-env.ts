/**
 * Static E2E-only values for gateway wiring. Referenced by both
 * playwright.config.ts (to spawn the gateway webServer) and the CI workflow
 * (as `env:` values), so keep them in lockstep.
 *
 * IMPORTANT: these are NOT production secrets. The 64-hex keys below are
 * deterministic padding used so parseServerEnv's HEX_64_REGEX accepts them
 * when ENABLE_GATEWAY=true. Never reuse these values outside E2E — real
 * envs must provide their own randomly-generated 32-byte hex strings.
 */

export const E2E_WEB_PORT = 3000;
export const E2E_API_PORT = 3001;
export const E2E_GATEWAY_PORT = 3002;
export const E2E_FAKE_ANTHROPIC_PORT = 4100;

export const E2E_GATEWAY_BASE_URL = `http://localhost:${E2E_GATEWAY_PORT}`;
export const E2E_FAKE_ANTHROPIC_URL = `http://localhost:${E2E_FAKE_ANTHROPIC_PORT}`;

// 64-char hex, E2E-only. DO NOT reuse in production / staging.
export const E2E_CREDENTIAL_ENCRYPTION_KEY = "0".repeat(64);
export const E2E_API_KEY_HASH_PEPPER = "1".repeat(64);
