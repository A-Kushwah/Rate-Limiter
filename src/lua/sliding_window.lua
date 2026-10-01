-- Sliding Window Counter (hybrid)
-- Combines a fixed-window count for the current bucket with a weighted
-- estimate of the previous bucket to approximate a true sliding window.
-- Cost: O(1) memory per key, with an approximate rolling count. Worst case
-- (sudden burst near a boundary) is close to 2x the configured limit.
--
-- KEYS[1] = current bucket key   rl:sw:<scope>:<id>:<cur_window_start>
-- KEYS[2] = previous bucket key  rl:sw:<scope>:<id>:<prev_window_start>
-- ARGV[1] = limit
-- ARGV[2] = window_ms
-- ARGV[3] = now_ms
-- ARGV[4] = current window_start (epoch ms)
-- ARGV[5] = ttl_sec
--
-- The weighting factor is the fraction of the previous window that is still
-- "in scope". If we are 30s into a 60s window, half of the previous window
-- still overlaps with our rolling view, so we count 0.5 * prev.

local cur_key   = KEYS[1]
local prev_key  = KEYS[2]
local limit     = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local now_ms    = tonumber(ARGV[3])
local cur_start = tonumber(ARGV[4])
local ttl_sec   = tonumber(ARGV[5])

local prev_count = tonumber(redis.call('GET', prev_key)) or 0
local cur_count  = tonumber(redis.call('GET', cur_key)) or 0

-- elapsed/window is the fraction of the previous window still in view
local elapsed = now_ms - cur_start
if elapsed < 0 then elapsed = 0 end
if elapsed > window_ms then elapsed = window_ms end
local weight = (window_ms - elapsed) / window_ms

local weighted = cur_count + (prev_count * weight)

if weighted < limit then
  local new_cur = redis.call('INCR', cur_key)
  if new_cur == 1 then redis.call('EXPIRE', cur_key, ttl_sec) end
  -- weighted is a float; remaining must round conservatively
  local remaining = math.floor(limit - weighted - 1)
  if remaining < 0 then remaining = 0 end
  return {1, remaining, cur_start + window_ms, 0}
else
  local retry_after
  if cur_count < limit and prev_count > 0 then
    local threshold_elapsed = window_ms * (1 - (limit - cur_count) / prev_count)
    retry_after = math.floor(threshold_elapsed - elapsed) + 1
  else
    local next_elapsed = 0
    if cur_count > 0 then
      next_elapsed = window_ms * (1 - limit / cur_count)
    end
    retry_after = (window_ms - elapsed) + math.floor(next_elapsed) + 1
  end
  if retry_after < 0 then retry_after = 0 end
  return {0, 0, cur_start + window_ms, retry_after}
end
