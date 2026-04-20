import type { Redis } from "ioredis";
import { ACQUIRE_SLOT_LUA } from "./lua/acquireSlot.js";

// TODO(part-7): emit gw_slot_acquire_total{scope, result} counter (design 4.9)
// TODO(perf): migrate from EVAL to defineCommand+EVALSHA when call rate warrants

/**
 * Atomically acquires a slot in a Redis ZSET rate-limiting bucket.
 *
 * Uses a Lua script to:
 *   1. Remove expired members (score <= now_ms)
 *   2. Check if current live member count >= limit
 *   3. If under limit, add (expiry_ms, requestId) and set a 300s safety EXPIRE
 *
 * @param redis     - ioredis client (keyPrefix is applied transparently)
 * @param key       - ZSET key without the keyPrefix (e.g. "slots:user:abc-123")
 * @param requestId - Unique identifier for this request/slot
 * @param limit     - Maximum number of concurrent slots allowed
 * @param durationMs - How long (ms) this slot is valid for
 * @returns true if the slot was acquired, false if at capacity
 */
export async function acquireSlot(
  redis: Redis,
  key: string,
  requestId: string,
  limit: number,
  durationMs: number,
): Promise<boolean> {
  const now = Date.now();
  const result = (await redis.eval(
    ACQUIRE_SLOT_LUA,
    1,
    key,
    String(now),
    String(durationMs),
    requestId,
    String(limit),
  )) as number;
  return result === 1;
}

/**
 * Releases a previously acquired slot by removing the member from the ZSET.
 *
 * This is not atomically paired with acquire — in the worst case, the expiry
 * score cleans up stale members on the next acquire call.
 *
 * @param redis     - ioredis client
 * @param key       - ZSET key without the keyPrefix
 * @param requestId - The same requestId used during acquireSlot
 */
export async function releaseSlot(
  redis: Redis,
  key: string,
  requestId: string,
): Promise<void> {
  await redis.zrem(key, requestId);
}
