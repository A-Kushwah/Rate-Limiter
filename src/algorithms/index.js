'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { client } = require('../redis');

// Load the Lua scripts once at boot. SCRIPT LOAD returns a SHA1 that I can
// reuse with EVALSHA for cheap execution. If Redis has flushed its script
// cache, retry that request with EVAL while the next reconnect reloads scripts.

const SCRIPTS = {
  'fixed-window': fs.readFileSync(path.join(__dirname, '..', 'lua/fixed_window.lua'), 'utf8'),
  'sliding-log': fs.readFileSync(path.join(__dirname, '..', 'lua/sliding_log.lua'), 'utf8'),
  'sliding-window': fs.readFileSync(path.join(__dirname, '..', 'lua/sliding_window.lua'), 'utf8'),
  'token-bucket': fs.readFileSync(path.join(__dirname, '..', 'lua/token_bucket.lua'), 'utf8'),
  'leaky-bucket': fs.readFileSync(path.join(__dirname, '..', 'lua/leaky_bucket.lua'), 'utf8'),
};

const SHAS = {};
let scriptsLoaded = false;

async function loadScripts() {
  for (const [name, src] of Object.entries(SCRIPTS)) {
    SHAS[name] = await client.script('LOAD', src);
  }
  scriptsLoaded = true;
}

function ensureLoaded() {
  if (!scriptsLoaded) throw new Error('Lua scripts not loaded yet — call loadScripts() at boot');
}

function areScriptsLoaded() {
  return scriptsLoaded;
}

// Build the Redis key for a given (algorithm, scope, id, window-start).
// Scoping the prefix by algorithm keeps different algorithms from clobbering
// each other if the same (route, client) is configured with different
// algorithms (e.g. via per-route overrides).
function makeKey(algorithm, scope, id, suffix = '') {
  return `rl:${algorithm}:${scope}:${id}${suffix}`;
}

function makeKeyNoSuffix(algorithm, scope, id) {
  return `rl:${algorithm}:${scope}:${id}`;
}

function uniqueMember() {
  // 8 random bytes + ms timestamp = unique enough for sorted set members.
  return `${Date.now()}:${crypto.randomBytes(6).toString('hex')}`;
}

async function evalScript(name, numKeys, ...args) {
  try {
    return await client.evalsha(SHAS[name], numKeys, ...args);
  } catch (err) {
    if (!err || typeof err.message !== 'string' || !err.message.startsWith('NOSCRIPT')) {
      throw err;
    }
    return client.eval(SCRIPTS[name], numKeys, ...args);
  }
}

// `scope` is typically the route pattern, e.g. "GET /login". The id is the
// resolved key (apiKey, userId, ip, or composite of those).
async function check(algorithm, scope, id, opts) {
  ensureLoaded();
  const { limit, windowMs, burst = 0 } = opts;
  const now = Date.now();
  const key = makeKeyNoSuffix(algorithm, scope, id);

  let raw;
  switch (algorithm) {
    case 'fixed-window': {
      const windowStart = Math.floor(now / windowMs) * windowMs;
      const resetAt = windowStart + windowMs;
      const k = makeKey(algorithm, scope, id, `:${windowStart}`);
      const ttlSec = Math.ceil((resetAt - now) / 1000) + 1;
      raw = await evalScript(
        'fixed-window',
        1, k,
        String(limit), String(ttlSec), String(now), String(resetAt)
      );
      break;
    }
    case 'sliding-log': {
      raw = await evalScript(
        'sliding-log',
        1, key,
        String(limit), String(windowMs), String(now), uniqueMember()
      );
      break;
    }
    case 'sliding-window': {
      const curStart = Math.floor(now / windowMs) * windowMs;
      const prevStart = curStart - windowMs;
      const curKey  = makeKey(algorithm, scope, id, `:${curStart}`);
      const prevKey = makeKey(algorithm, scope, id, `:${prevStart}`);
      const ttlSec = Math.ceil(windowMs / 1000) * 2 + 1;
      raw = await evalScript(
        'sliding-window',
        2, curKey, prevKey,
        String(limit), String(windowMs), String(now), String(curStart), String(ttlSec)
      );
      break;
    }
    case 'token-bucket': {
      const capacity = limit + burst;
      const rate = limit / (windowMs / 1000);
      const ttlSec = Math.ceil(capacity / rate) + 1;
      raw = await evalScript(
        'token-bucket',
        1, key,
        String(capacity), String(rate), String(now), String(ttlSec)
      );
      break;
    }
    case 'leaky-bucket': {
      const capacity = limit;
      // Leak rate: limit requests per windowMs seconds (so steady-state output
      // matches `limit` per window). This algorithm intentionally has no
      // additional configurable burst capacity.
      const rate = limit / (windowMs / 1000);
      const ttlSec = Math.ceil(capacity / rate) + 1;
      raw = await evalScript(
        'leaky-bucket',
        1, key,
        String(capacity), String(rate), String(now), String(ttlSec)
      );
      break;
    }
    default:
      throw new Error(`Unknown algorithm: ${algorithm}`);
  }

  // Lua returns: { allowed (0/1), remaining, reset_at, retry_after_ms }
  return {
    allowed: raw[0] === 1,
    remaining: raw[1],
    resetAt: Number(raw[2]),
    retryAfterMs: Number(raw[3]),
  };
}

module.exports = { check, loadScripts, areScriptsLoaded, makeKey, makeKeyNoSuffix, evalScript };
