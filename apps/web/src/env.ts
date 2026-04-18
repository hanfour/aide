import { parseServerEnv, type ServerEnv } from "@aide/config/env";

let cached: ServerEnv | null = null;

export function getEnv(): ServerEnv {
  if (!cached) cached = parseServerEnv();
  return cached;
}
