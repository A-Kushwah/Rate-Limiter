'use strict';

const Redis = require('ioredis');
const config = require('./config');

// Single shared connection. ioredis handles reconnects automatically; we just
// surface failures via the 'error' event so the logger can record them. We do
// NOT crash the process on a transient Redis blip — the limiter will fail open
// (configurable) and the request will be allowed through with a header
// warning. That is the safer default for a rate limiter in front of a paying
// API: dropping traffic because the limiter is down is worse than briefly not
// rate-limiting.
const client = new Redis(config.redisUrl, {
  // Don't queue commands forever while disconnected — we'd rather fail fast
  // and let the middleware decide what to do.
  maxRetriesPerRequest: 1,
  enableReadyCheck: true,
  // Lazy connect so a missing Redis at boot doesn't kill the process before
  // the health check has a chance to report it.
  lazyConnect: true,
  retryStrategy: (times) => Math.min(times * 200, 2_000),
});

let ready = false;
client.on('ready', () => {
  ready = true;
  console.log('[redis] ready');
});
client.on('error', (err) => {
  // Don't spam logs — ioredis can fire this rapidly on reconnect.
  if (ready) console.error('[redis] error:', err.message);
  ready = false;
});
client.on('end', () => {
  ready = false;
  console.warn('[redis] connection ended');
});

async function connect() {
  if (client.status === 'ready' || client.status === 'connecting') return;
  await client.connect();
}

function isReady() {
  return ready && client.status === 'ready';
}

module.exports = { client, connect, isReady };
