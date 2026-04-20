import type { Redis } from "ioredis";

// TODO(part-7): emit gw_idempotency_hit_total counter (design 4.9)

export interface CachedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  // Discriminator: completed responses serialize without `marker`
  marker?: never;
}

export interface InFlightMarker {
  marker: "in_progress";
  startedAt: number; // epoch ms
}

export type IdempotencyEntry = CachedResponse | InFlightMarker;

function idemKey(requestId: string): string {
  return `idem:${requestId}`;
}

export async function getCached(
  redis: Redis,
  requestId: string,
): Promise<IdempotencyEntry | null> {
  const raw = await redis.get(idemKey(requestId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as IdempotencyEntry;
  } catch {
    // Malformed cache entry; treat as miss. (TODO(part-7): emit malformed metric.)
    return null;
  }
}

export async function setCached(
  redis: Redis,
  requestId: string,
  response: CachedResponse,
  ttlSec: number,
): Promise<void> {
  await redis.set(idemKey(requestId), JSON.stringify(response), "EX", ttlSec);
}

export async function setInFlight(
  redis: Redis,
  requestId: string,
  ttlSec: number,
): Promise<void> {
  const marker: InFlightMarker = { marker: "in_progress", startedAt: Date.now() };
  await redis.set(idemKey(requestId), JSON.stringify(marker), "EX", ttlSec);
}

export function isInFlight(entry: IdempotencyEntry): entry is InFlightMarker {
  return (entry as InFlightMarker).marker === "in_progress";
}
