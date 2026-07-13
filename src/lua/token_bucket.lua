-- Token Bucket
-- Tokens refill continuously at a steady rate. Each request consumes one
-- token. If the bucket has tokens, allow and decrement; otherwise block.
-- Burst = max tokens the bucket can hold (== capacity, equals limit + burst).
--
-- KEYS[1] = bucket hash key  rl:tb:<scope>:<id>
-- ARGV[1] = capacity         (max tokens == limit + burst)
-- ARGV[2] = refill_rate      (tokens per second)
-- ARGV[3] = now_ms
-- ARGV[4] = ttl_sec          (so abandoned keys don't pile up)
--
-- State: { tokens: float, ts: int } in a hash.
-- On each request we:
--   1. Read last state (default full bucket at "infinite ago").
--   2. Compute tokens added since last request = (now - last_ts) * rate.
--   3. Cap at capacity.
--   4. If tokens >= 1, decrement by 1 and allow.
--   5. Otherwise block; retry_after = (1 - tokens) / rate * 1000 ms.
--
-- We persist state back atomically — that's the whole point of doing this
-- in Lua: read-modify-write in one round trip, no race.

local key         = KEYS[1]
local capacity    = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])  -- tokens per second
local now_ms      = tonumber(ARGV[3])
local ttl_sec     = tonumber(ARGV[4])

local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts     = tonumber(data[2])

if tokens == nil or ts == nil then
  tokens = capacity
  ts = now_ms
end

local elapsed_ms = now_ms - ts
if elapsed_ms < 0 then elapsed_ms = 0 end

-- Refill: capacity tokens / (capacity / refill_rate) seconds = refill_rate tps
local refilled = tokens + (elapsed_ms / 1000.0) * refill_rate
if refilled > capacity then refilled = capacity end

local allowed
local retry_after_ms
local remaining
if refilled >= 1 then
  refilled = refilled - 1
  remaining = math.floor(refilled)
  allowed = 1
  retry_after_ms = 0
else
  allowed = 0
  remaining = 0
  -- how long until 1 full token is available
  retry_after_ms = math.ceil((1 - refilled) / refill_rate * 1000)
end

-- Persist state. Use HSET (not HMSET — deprecated) and PEXPIRE together
-- so idle keys disappear. We use HSET + PEXPIRE rather than one call
-- because Lua wrappers for some Redis versions don't expose HSET with
-- multiple field/value pairs the same way.
redis.call('HSET', key, 'tokens', refilled, 'ts', now_ms)
redis.call('PEXPIRE', key, ttl_sec * 1000)

-- reset_at = when the bucket would be full again
local reset_at = now_ms + math.ceil((capacity - refilled) / refill_rate * 1000)

return {allowed, remaining, reset_at, retry_after_ms}
