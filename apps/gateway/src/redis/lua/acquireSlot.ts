// KEYS[1] = slots ZSET key
// ARGV[1] = now_ms
// ARGV[2] = durationMs (slot lifetime; expiry is computed inside the script)
// ARGV[3] = request_id
// ARGV[4] = limit
// Returns 1 if acquired, 0 if at capacity
export const ACQUIRE_SLOT_LUA = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local count = redis.call('ZCARD', KEYS[1])
if count >= tonumber(ARGV[4]) then return 0 end
local expiry = tonumber(ARGV[1]) + tonumber(ARGV[2])
redis.call('ZADD', KEYS[1], expiry, ARGV[3])
redis.call('EXPIRE', KEYS[1], 300)
return 1
` as const;
