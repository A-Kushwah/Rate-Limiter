'use strict';

// One place for app config. I parse the environment once at startup so the
// rest of the app can assume the values are already normalized.

require('dotenv').config();

const ALGORITHMS = new Set([
  'fixed-window',
  'sliding-log',
  'sliding-window',
  'token-bucket',
  'leaky-bucket',
]);

const STRATEGIES = new Set(['apiKey', 'userId', 'ip', 'composite']);

function parseInt10(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseRoutes(raw) {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    // Normalise numeric fields so downstream code never sees strings.
    for (const [path, cfg] of Object.entries(parsed)) {
      if (cfg.windowMs != null) cfg.windowMs = parseInt10(cfg.windowMs, 60000);
      if (cfg.limit != null) cfg.limit = parseInt10(cfg.limit, 60);
      if (cfg.burst != null) cfg.burst = parseInt10(cfg.burst, 0);
      if (cfg.algorithm != null && !ALGORITHMS.has(cfg.algorithm)) {
        throw new Error(`Invalid algorithm for ${path}: ${cfg.algorithm}`);
      }
    }
    return parsed;
  } catch (e) {
    console.error('[config] Failed to parse ROUTES_JSON:', e.message);
    return {};
  }
}

const algorithm = (process.env.ALGORITHM || 'token-bucket').trim();
if (!ALGORITHMS.has(algorithm)) {
  throw new Error(`Invalid ALGORITHM: ${algorithm}. Must be one of: ${[...ALGORITHMS].join(', ')}`);
}

const keyStrategy = (process.env.KEY_STRATEGY || 'ip').trim();
if (!STRATEGIES.has(keyStrategy)) {
  throw new Error(`Invalid KEY_STRATEGY: ${keyStrategy}`);
}

module.exports = {
  port: parseInt10(process.env.PORT, 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  algorithm,
  windowMs: parseInt10(process.env.WINDOW_MS, 60_000),
  limit: parseInt10(process.env.LIMIT, 60),
  burst: parseInt10(process.env.BURST, 20),
  keyStrategy,
  routes: parseRoutes(process.env.ROUTES_JSON),
  dashboardEnabled: (process.env.DASHBOARD_ENABLED || 'true') === 'true',
  algorithms: [...ALGORITHMS],
};
