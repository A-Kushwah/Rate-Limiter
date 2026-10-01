'use strict';

// One place for app config. I parse the environment once at startup so the
// rest of the app can assume the values are already normalized.

const { URL } = require('url');
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
  const value = typeof v === 'string' ? v.trim() : v;
  if (value === '') return fallback;
  if (typeof value === 'string' && !/^[+-]?\d+$/.test(value)) return fallback;
  if (typeof value !== 'number' && typeof value !== 'string') return fallback;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : fallback;
}

function parseEnvInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const parsed = parseInt10(raw, NaN);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function parseRouteInt(value, path, field, minimum) {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new Error(`Invalid ${field} for ${path}: expected an integer >= ${minimum}`);
  }
  const parsed = parseInt10(value, NaN);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`Invalid ${field} for ${path}: expected an integer >= ${minimum}`);
  }
  return parsed;
}

function parseRoutes(raw) {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('expected a JSON object');
    }
    // Normalise numeric fields so downstream code never sees strings.
    for (const [path, cfg] of Object.entries(parsed)) {
      if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) {
        throw new Error(`expected an object for route ${path}`);
      }
      if (cfg.windowMs != null) cfg.windowMs = parseRouteInt(cfg.windowMs, path, 'windowMs', 1);
      if (cfg.limit != null) cfg.limit = parseRouteInt(cfg.limit, path, 'limit', 1);
      if (cfg.burst != null) cfg.burst = parseRouteInt(cfg.burst, path, 'burst', 0);
      if (cfg.algorithm != null && !ALGORITHMS.has(cfg.algorithm)) {
        throw new Error(`Invalid algorithm for ${path}: ${cfg.algorithm}`);
      }
    }
    return parsed;
  } catch (e) {
    throw new Error(`[config] Invalid ROUTES_JSON: ${e.message}`);
  }
}

function parseRedisUrl(raw) {
  if (!raw || !raw.trim()) return 'redis://127.0.0.1:6379';
  const value = raw.trim();
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
      throw new Error(`Unsupported protocol ${parsed.protocol}`);
    }
    return parsed.toString();
  } catch (e) {
    console.error('[config] Invalid REDIS_URL. Expected redis://... or rediss://... Falling back to localhost Redis.');
    return 'redis://127.0.0.1:6379';
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

const port = parseEnvInt('PORT', 3000);
const windowMs = parseEnvInt('WINDOW_MS', 60_000);
const limit = parseEnvInt('LIMIT', 60);
const burst = parseEnvInt('BURST', 20);

if (port < 1 || port > 65_535) throw new Error('PORT must be between 1 and 65535');
if (windowMs < 1) throw new Error('WINDOW_MS must be a positive integer');
if (limit < 1) throw new Error('LIMIT must be a positive integer');
if (burst < 0) throw new Error('BURST must be a non-negative integer');

module.exports = {
  port,
  nodeEnv: process.env.NODE_ENV || 'development',
  redisUrl: parseRedisUrl(process.env.REDIS_URL),
  algorithm,
  windowMs,
  limit,
  burst,
  keyStrategy,
  routes: parseRoutes(process.env.ROUTES_JSON),
  dashboardEnabled: (process.env.DASHBOARD_ENABLED || 'true') === 'true',
  algorithms: [...ALGORITHMS],
};
