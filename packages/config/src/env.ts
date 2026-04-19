import { z } from "zod";

export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  DATABASE_URL: z.string().url(),
  AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 characters"),
  NEXTAUTH_URL: z.string().url(),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GITHUB_CLIENT_ID: z.string().min(1),
  GITHUB_CLIENT_SECRET: z.string().min(1),
  BOOTSTRAP_SUPER_ADMIN_EMAIL: z.string().email(),
  BOOTSTRAP_DEFAULT_ORG_SLUG: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/),
  BOOTSTRAP_DEFAULT_ORG_NAME: z.string().min(1),
  ENABLE_SWAGGER: z
    .union([z.boolean(), z.string()])
    .transform((v) => (typeof v === "string" ? v === "true" : v))
    .default(false),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  API_INTERNAL_URL: z.string().url().optional(),
  ENABLE_TEST_SEED: z
    .union([z.boolean(), z.string()])
    .transform((v) => (typeof v === "string" ? v === "true" : v))
    .default(false),
  TEST_SEED_TOKEN: z.string().min(32).optional(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export function parseServerEnv(
  raw: Record<string, unknown> = process.env,
): ServerEnv {
  const result = serverEnvSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
