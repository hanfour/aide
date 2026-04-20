// KEYS[1] = wait queue ZSET key
// ARGV[1] = now_ms (used as score)
// ARGV[2] = request_id
// ARGV[3] = maxWait (cap)
// Returns 1 if enqueued, 0 if at capacity
export const ENQUEUE_WAIT_LUA = `
local count = redis.call('ZCARD', KEYS[1])
if count >= tonumber(ARGV[3]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
redis.call('EXPIRE', KEYS[1], 300)
return 1
` as const;
