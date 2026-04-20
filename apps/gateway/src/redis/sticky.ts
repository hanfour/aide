import type { Redis } from "ioredis";

// TODO(part-7): emit gw_sticky_hit_total counter (design 4.9)

function stickyKey(orgId: string, sessionId: string): string {
  return `sticky:${orgId}:${sessionId}`;
}

export async function getSticky(
  redis: Redis,
  orgId: string,
  sessionId: string,
): Promise<string | null> {
  return await redis.get(stickyKey(orgId, sessionId));
}

export async function setSticky(
  redis: Redis,
  orgId: string,
  sessionId: string,
  accountId: string,
  ttlSec: number,
): Promise<void> {
  await redis.set(stickyKey(orgId, sessionId), accountId, "EX", ttlSec);
}

export async function deleteSticky(
  redis: Redis,
  orgId: string,
  sessionId: string,
): Promise<void> {
  await redis.del(stickyKey(orgId, sessionId));
}
