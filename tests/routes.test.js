'use strict';

// Unit tests for ROUTES_JSON matching/merging logic. These don't touch
// Redis at all — resolveRouteConfig/matchedRoutePrefix are pure functions
// over process.env.ROUTES_JSON + config defaults, so they can run standalone.
//
// Run with: node --test tests/routes.test.js
//
// IMPORTANT: ROUTES_JSON must be set *before* requiring src/config (it's
// parsed once at module load time), so this file sets env vars up top.

process.env.ROUTES_JSON = JSON.stringify({
  'POST /api/login': { limit: 5, windowMs: 60000, burst: 0, algorithm: 'fixed-window' },
  'GET /api/search': { limit: 100, windowMs: 60000, burst: 50 },
  '/api/admin': { limit: 10, windowMs: 60000, burst: 0 },
});
process.env.LIMIT = '60';
process.env.BURST = '20';
process.env.WINDOW_MS = '60000';
process.env.ALGORITHM = 'token-bucket';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveRouteConfig,
  matchedRoutePrefix,
  resolveRouteScope,
  resolveId,
} = require('../src/middleware/limiter');

test('exact METHOD /path override applies, including explicit burst: 0', () => {
  const cfg = resolveRouteConfig('POST', '/api/login');
  assert.deepEqual(cfg, { algorithm: 'fixed-window', limit: 5, windowMs: 60000, burst: 0 });
});

test('a different method to the same path does NOT get the override', () => {
  // GET /api/login isn't configured, so it should fall back to defaults,
  // not accidentally match "POST /api/login".
  const cfg = resolveRouteConfig('GET', '/api/login');
  assert.deepEqual(cfg, { algorithm: 'token-bucket', limit: 60, windowMs: 60000, burst: 20 });
});

test('GET /api/search override applies', () => {
  const cfg = resolveRouteConfig('GET', '/api/search');
  assert.deepEqual(cfg, { algorithm: 'token-bucket', limit: 100, windowMs: 60000, burst: 50 });
});

test('bare path prefix (no method) matches any method', () => {
  assert.equal(matchedRoutePrefix('GET', '/api/admin/users'), '/api/admin');
  assert.equal(matchedRoutePrefix('DELETE', '/api/admin/users/5'), '/api/admin');
});

test('unconfigured route falls back to global defaults', () => {
  const cfg = resolveRouteConfig('GET', '/api/expensive');
  assert.deepEqual(cfg, { algorithm: 'token-bucket', limit: 60, windowMs: 60000, burst: 20 });
});

test('unknown routes share a bounded scope instead of allocating per-path keys', () => {
  assert.equal(resolveRouteScope('GET', '/api/random-one', '/api'), 'GET /api/*');
  assert.equal(resolveRouteScope('GET', '/api/random-two', '/api'), 'GET /api/*');
});

test('composite client identifiers do not collide when fields contain separators', () => {
  const request = (apiKey, userId, ip) => ({
    get: header => header === 'x-api-key' ? apiKey : header === 'x-user-id' ? userId : null,
    user: null,
    ip,
    socket: { remoteAddress: ip },
  });
  const first = resolveId('composite', request('a|b', 'c', 'd'));
  const second = resolveId('composite', request('a', 'b|c', 'd'));
  assert.notEqual(first, second);
});
