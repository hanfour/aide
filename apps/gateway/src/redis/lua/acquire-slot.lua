-- KEYS[1] = slots ZSET key
-- ARGV[1] = now_ms
-- ARGV[2] = expiry_ms (now + durationMs)
-- ARGV[3] = request_id
-- ARGV[4] = limit
-- Returns 1 if acquired, 0 if at capacity

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local count = redis.call('ZCARD', KEYS[1])
if count >= tonumber(ARGV[4]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
redis.call('EXPIRE', KEYS[1], 300)
return 1
