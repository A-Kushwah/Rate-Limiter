-- Leaky Bucket
-- Requests drain at a constant rate (think: a queue with a leak at the
-- bottom). The bucket has a fixed capacity; if full, new requests spill
-- (i.e. are rejected). Unlike token bucket, refill is constant per tick,
-- not proportional to elapsed time — but the *steady-state* behaviour is
-- the same: smooth output rate.
--
-- Implementation: store the current water level. On each request, compute
-- how much has leaked out since last call (elapsed * rate), clamp at 0,
-- add 1 for the incoming request, then allow/block based on capacity.
--
-- KEYS[1] = bucket key
-- ARGV[1] = capacity
-- ARGV[2] = leak_rate        (requests per second)
-- ARGV[3] = now_ms
-- ARGV[4] = ttl_sec

local key      = KEYS[1]
local capacity = tonumber(ARGV[1])
local rate     = tonumber(ARGV[2])
local now_ms   = tonumber(ARGV[3])
local ttl_sec  = tonumber(ARGV[4])

local data = redis.call('HMGET', key, 'level', 'ts')
local level = tonumber(data[1])
local ts    = tonumber(data[2])

if level == nil or ts == nil then
  level = 0
  ts = now_ms
end

local elapsed_ms = now_ms - ts
if elapsed_ms < 0 then elapsed_ms = 0 end

local leaked = (elapsed_ms / 1000.0) * rate
level = level - leaked
if level < 0 then level = 0 end

local allowed
local retry_after_ms
local remaining
if level + 1 <= capacity then
  level = level + 1
  allowed = 1
  remaining = math.floor(capacity - level)
  retry_after_ms = 0
else
  allowed = 0
  remaining = 0
  -- wait until enough has leaked to fit one more
  retry_after_ms = math.ceil(((level + 1) - capacity) / rate * 1000)
end

redis.call('HSET', key, 'level', level, 'ts', now_ms)
redis.call('PEXPIRE', key, ttl_sec * 1000)

local reset_at = now_ms + math.ceil((level / rate) * 1000)

return {allowed, remaining, reset_at, retry_after_ms}
