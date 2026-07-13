-- Fixed Window Counter
-- KEYS[1] = bucket key  e.g. rl:fw:<scope>:<id>:<window-start>
-- ARGV[1] = limit       (integer)
-- ARGV[2] = window TTL  (seconds, integer)
--
-- Returns: { allowed (0/1), remaining, reset_at_ms, retry_after_ms }
--
-- The key is namespaced with the window-start epoch so we don't have to
-- delete it manually — Redis expires it on its own. Two requests arriving
-- at the boundary land in different buckets, which is the well-known
-- "double burst at the boundary" weakness of this algorithm. It's
-- documented in the README under tradeoffs.

local key      = KEYS[1]
local limit    = tonumber(ARGV[1])
local ttl_sec  = tonumber(ARGV[2])

local current = redis.call('INCR', key)
if current == 1 then
  -- Only set TTL on the first request of the window.
  redis.call('EXPIRE', key, ttl_sec)
end

local pttl = redis.call('PTTL', key)
-- PTTL returns -1 if no TTL is set, -2 if key missing. Guard both.
if pttl < 0 then
  redis.call('EXPIRE', key, ttl_sec)
  pttl = ttl_sec * 1000
end

local reset_at = tonumber(ARGV[3]) + pttl
if current <= limit then
  return {1, limit - current, reset_at, 0}
else
  return {0, 0, reset_at, pttl}
end
