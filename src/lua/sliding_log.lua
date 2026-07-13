-- Sliding Window Log
-- KEYS[1] = log key  (sorted set)
-- ARGV[1] = limit
-- ARGV[2] = window_ms
-- ARGV[3] = now_ms
-- ARGV[4] = unique member (e.g. "now_ms:rand")
--
-- Stores every request timestamp in a sorted set scored by epoch ms.
-- Each request: trim old entries, then count remaining. Exact — but O(n)
-- memory per key, where n = limit. Use only when accuracy matters more
-- than memory (e.g. financial APIs).

local key       = KEYS[1]
local limit     = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local now_ms    = tonumber(ARGV[3])
local member    = ARGV[4]

local cutoff = now_ms - window_ms
-- Drop anything older than the window. Single ZREMRANGEBYSCORE.
redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)
local count = redis.call('ZCARD', key)

if count < limit then
  redis.call('ZADD', key, now_ms, member)
  -- Set TTL slightly larger than the window so abandoned keys don't linger.
  redis.call('PEXPIRE', key, window_ms + 1000)
  local remaining = limit - (count + 1)
  -- reset = when the oldest entry in the window will fall out
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local reset_at = now_ms + window_ms
  if oldest and oldest[2] then
    reset_at = tonumber(oldest[2]) + window_ms
  end
  return {1, remaining, reset_at, 0}
else
  -- Blocked: compute retry_after from the oldest entry
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local reset_at = now_ms + window_ms
  local retry_after = window_ms
  if oldest and oldest[2] then
    reset_at = tonumber(oldest[2]) + window_ms
    retry_after = reset_at - now_ms
    if retry_after < 0 then retry_after = 0 end
  end
  return {0, 0, reset_at, retry_after}
end
