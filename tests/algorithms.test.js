'use strict';

// Unit tests for algorithm correctness. Run against a real Redis so the Lua
// scripts are exercised as in production. Uses the built-in `node:test`
// runner — no extra dependencies.
//
// Run with:  npm test
// Requires:  REDIS_URL pointing to a reachable Redis instance (defaults to
//            127.0.0.1:6379). The tests create and drop their own keys
// under the `unit` scope so they don't interfere with app state.

const test = require('node:test');
const assert = require('node:assert/strict');

const { client: redis, connect, isReady } = require('../src/redis');
const { loadScripts, check, makeKey } = require('../src/algorithms');

test.before(async () => {
  try {
    await connect();
    await loadScripts();
  } catch (err) {
    if (redis.status !== 'end' && typeof redis.disconnect === 'function') redis.disconnect();
    throw new Error(`Unable to initialize Redis Lua scripts for algorithm tests: ${err.message}`);
  }
  // Clear any leftover state from a previous run. Test IDs are unique
  // per-test (tb-1, sw-2, fw-race, etc.) so collisions are unlikely, but
  // a stale key from a previous run would skew the concurrent tests.
  const keys = await redis.keys('rl:*:unit:*');
  if (keys.length) await redis.del(...keys);
});

test.after(async () => {
  if (!isReady()) {
    if (redis.status !== 'end' && typeof redis.disconnect === 'function') redis.disconnect();
    return;
  }
  const keys = await redis.keys('rl:*:unit:*');
  if (keys.length) await redis.del(...keys);
  await redis.quit();
});

// --- Helpers ---
async function runN(algo, id, n, opts) {
  const results = [];
  for (let i = 0; i < n; i++) {
    results.push(await check(algo, 'unit', id, opts));
  }
  return results;
}

// -------- Fixed Window --------
test('fixed-window: allows exactly limit, then blocks', async () => {
  const id = 'fw-1';
  const opts = { limit: 5, windowMs: 60_000 };
  const r = await runN('fixed-window', id, 7, opts);
  assert.deepEqual(r.slice(0, 5).map(x => x.allowed), [true, true, true, true, true]);
  assert.deepEqual(r.slice(5).map(x => x.allowed), [false, false]);
  assert.equal(r[0].remaining, 4);
  assert.equal(r[4].remaining, 0);
  assert.equal(r[5].remaining, 0);
  assert.ok(r[5].retryAfterMs > 0);
});

test('fixed-window: reset time and retry delay end at the bucket boundary', async () => {
  const id = 'fw-reset';
  const windowMs = 3_600_000;
  const before = Date.now();
  const expectedResetAt = (Math.floor(before / windowMs) + 1) * windowMs;
  const opts = { limit: 1, windowMs };
  await runN('fixed-window', id, 1, opts);
  const blocked = await check('fixed-window', 'unit', id, opts);
  assert.equal(blocked.resetAt, expectedResetAt);
  assert.ok(blocked.retryAfterMs > 0);
  assert.ok(blocked.retryAfterMs <= blocked.resetAt - Date.now() + 100);
});

// -------- Sliding Log --------
test('sliding-log: oldest entry rolls out of window', async () => {
  const id = 'sl-1';
  const opts = { limit: 3, windowMs: 200 }; // 200ms window so we can wait it out
  let r = await runN('sliding-log', id, 3, opts);
  assert.equal(r.every(x => x.allowed), true);
  r = await check('sliding-log', 'unit', id, opts);
  assert.equal(r.allowed, false, '4th should be blocked');
  await new Promise(res => setTimeout(res, 250));
  r = await check('sliding-log', 'unit', id, opts);
  assert.equal(r.allowed, true, 'after window passes, should be allowed again');
});

test('sliding-log: remains blocked inside window even after time passes (still under cap)', async () => {
  const id = 'sl-2';
  const opts = { limit: 2, windowMs: 500 };
  await runN('sliding-log', id, 2, opts);
  await new Promise(res => setTimeout(res, 100));
  const r = await check('sliding-log', 'unit', id, opts);
  assert.equal(r.allowed, false, 'still inside window with full log');
});

// -------- Sliding Window (hybrid) --------
test('sliding-window: weighted count from previous window', async () => {
  const id = 'sw-1';
  const windowMs = 1000;
  const opts = { limit: 5, windowMs };
  // Fill 5 in current window
  await runN('sliding-window', id, 5, opts);
  // Immediately — should be blocked (5/5 used)
  let r = await check('sliding-window', 'unit', id, opts);
  assert.equal(r.allowed, false);

  // Wait > 1 window so previous bucket is fully out of scope
  await new Promise(res => setTimeout(res, windowMs + 50));
  // Wait *one more* windowMs so previous (still full) bucket is gone
  await new Promise(res => setTimeout(res, windowMs + 50));
  r = await check('sliding-window', 'unit', id, opts);
  assert.equal(r.allowed, true, 'after two full windows, fresh allowance');
});

test('sliding-window: fractional previous count permits a boundary allowance', async () => {
  const id = 'sw-2';
  const limit = 3;
  const windowMs = 1000;
  const curStart = Math.floor(Date.now() / windowMs) * windowMs;
  const now = curStart + 20;
  const prevKey = makeKey('sliding-window', 'unit', id, `:${curStart - windowMs}`);
  await redis.set(prevKey, String(limit));

  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const result = await check('sliding-window', 'unit', id, { limit, windowMs });
    assert.equal(result.allowed, true);
    assert.equal(result.remaining, 0);
  } finally {
    Date.now = originalNow;
  }
});

test('sliding-window: blocks further requests after boundary allowance', async () => {
  const id = 'sw-boundary';
  const limit = 3;
  const windowMs = 1000;
  const curStart = Math.floor(Date.now() / windowMs) * windowMs;
  const now = curStart + 1;
  const prevKey = makeKey('sliding-window', 'unit', id, `:${curStart - windowMs}`);
  await redis.set(prevKey, String(limit));

  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => check('sliding-window', 'unit', id, { limit, windowMs }))
    );
    assert.equal(results.filter(result => result.allowed).length, 1);
  } finally {
    Date.now = originalNow;
  }
});

test('sliding-window: retry delay is relative to the current time', async () => {
  const id = 'sw-retry';
  const limit = 3;
  const windowMs = 10_000;
  const curStart = Math.floor(Date.now() / windowMs) * windowMs;
  const now = curStart + windowMs - 2_000;
  const curKey = makeKey('sliding-window', 'unit', id, `:${curStart}`);
  const prevKey = makeKey('sliding-window', 'unit', id, `:${curStart - windowMs}`);
  await redis.set(curKey, String(limit));
  await redis.set(prevKey, String(limit));

  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const result = await check('sliding-window', 'unit', id, { limit, windowMs });
    assert.equal(result.allowed, false);
    assert.equal(result.resetAt, curStart + windowMs);
    assert.equal(result.retryAfterMs, windowMs - (now - curStart) + 1);
  } finally {
    Date.now = originalNow;
  }
});

// -------- Token Bucket --------
test('token-bucket: allows burst up to capacity, then steady refill', async () => {
  const id = 'tb-1';
  const opts = { limit: 3, windowMs: 1000, burst: 2 }; // capacity = 5, rate = 3/s
  // Burst 5
  const r = await runN('token-bucket', id, 5, opts);
  assert.equal(r.every(x => x.allowed), true, 'first 5 should fit capacity');
  // 6th should be blocked
  const r6 = await check('token-bucket', 'unit', id, opts);
  assert.equal(r6.allowed, false);
  // Refill follows the configured limit: 3 tokens per second.
  await new Promise(res => setTimeout(res, 350));
  const r7 = await check('token-bucket', 'unit', id, opts);
  assert.equal(r7.allowed, true, 'after refill interval, allowed again');
});

test('token-bucket: never allows more than capacity in a single instant', async () => {
  const id = 'tb-2';
  const opts = { limit: 10, windowMs: 60_000, burst: 0 };
  const r = await runN('token-bucket', id, 12, opts);
  const allowed = r.filter(x => x.allowed).length;
  assert.equal(allowed, 10, 'exactly capacity allowed');
});

test('token-bucket: idle-key TTL cannot refill capacity early', async () => {
  const id = 'tb-ttl';
  const opts = { limit: 1, windowMs: 10_000, burst: 100 };
  await check('token-bucket', 'unit', id, opts);
  const ttl = await redis.pttl(makeKey('token-bucket', 'unit', id));
  assert.ok(ttl > 1_010_000, `expected TTL to cover full refill period, got ${ttl}ms`);
});

// -------- Leaky Bucket --------
test('leaky-bucket: rejects when bucket full, allows after leak', async () => {
  const id = 'lb-1';
  const opts = { limit: 5, windowMs: 1000, burst: 0 }; // capacity 5, leak 5/s
  // Fill it
  const r = await runN('leaky-bucket', id, 5, opts);
  assert.equal(r.every(x => x.allowed), true);
  // Next one should be blocked
  const r6 = await check('leaky-bucket', 'unit', id, opts);
  assert.equal(r6.allowed, false);
  // After 250ms, ~1.25 requests have leaked — at least one slot
  await new Promise(res => setTimeout(res, 260));
  const r7 = await check('leaky-bucket', 'unit', id, opts);
  assert.equal(r7.allowed, true);
});

test('leaky-bucket: burst does not increase its immediate capacity', async () => {
  const opts = { limit: 2, windowMs: 1000, burst: 20 };
  const results = await runN('leaky-bucket', 'lb-burst', 3, opts);
  assert.deepEqual(results.map(result => result.allowed), [true, true, false]);
});

// -------- Idempotency / shape --------
test('all algorithms return uniform {allowed, remaining, resetAt, retryAfterMs}', async () => {
  for (const algo of ['fixed-window', 'sliding-log', 'sliding-window', 'token-bucket', 'leaky-bucket']) {
    const r = await check(algo, `shape-${algo}`, 'unit', { limit: 5, windowMs: 1000, burst: 2 });
    for (const k of ['allowed', 'remaining', 'resetAt', 'retryAfterMs']) {
      assert.ok(k in r, `${algo} missing ${k}`);
    }
    assert.equal(typeof r.allowed, 'boolean');
    assert.equal(typeof r.remaining, 'number');
    assert.equal(typeof r.resetAt, 'number');
    assert.equal(typeof r.retryAfterMs, 'number');
  }
});

// -------- Concurrency: no over-allowance under race --------
test('token-bucket: 100 concurrent requests allow exactly capacity', async () => {
  const id = 'tb-race';
  const opts = { limit: 10, windowMs: 60_000, burst: 0 };
  const promises = [];
  for (let i = 0; i < 100; i++) {
    promises.push(check('token-bucket', 'unit', id, opts));
  }
  const results = await Promise.all(promises);
  const allowed = results.filter(x => x.allowed).length;
  assert.equal(allowed, 10, `expected exactly 10 allowed, got ${allowed}`);
});

test('fixed-window: 100 concurrent requests allow exactly limit', async () => {
  const id = 'fw-race';
  const opts = { limit: 7, windowMs: 60_000 };
  const promises = [];
  for (let i = 0; i < 100; i++) {
    promises.push(check('fixed-window', 'unit', id, opts));
  }
  const results = await Promise.all(promises);
  const allowed = results.filter(x => x.allowed).length;
  assert.equal(allowed, 7, `expected exactly 7 allowed, got ${allowed}`);
});

// Sanity: Redis connection is actually used
test('redis: connection is ready', () => {
  assert.ok(isReady(), 'expected Redis to be ready for tests');
});
