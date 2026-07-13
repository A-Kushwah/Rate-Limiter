'use strict';

const Redis = require('ioredis');
const config = require('./config');

function createNoopClient() {
  return {
    status: 'end',
    on() {},
    connect() { return Promise.resolve(); },
    script() { throw new Error('Redis is unavailable'); },
    evalsha() { throw new Error('Redis is unavailable'); },
    quit() { return Promise.resolve(); },
    keys() { return Promise.resolve([]); },
    del() { return Promise.resolve(0); },
  };
}

let client;
let ready = false;

if (config.redisUrl === 'redis://127.0.0.1:6379' && process.env.REDIS_URL) {
  console.warn('[redis] Using localhost fallback because REDIS_URL was invalid or missing.');
}

if (config.redisUrl) {
  client = new Redis(config.redisUrl, {
    // Don't queue commands forever while disconnected — we'd rather fail fast
    // and let the middleware decide what to do.
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    // Lazy connect so a missing Redis at boot doesn't kill the process before
    // the health check has a chance to report it.
    lazyConnect: true,
    retryStrategy: (times) => Math.min(times * 200, 2_000),
  });

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
} else {
  client = createNoopClient();
}

async function connect() {
  if (!client || client.status === 'ready' || client.status === 'connecting') return;
  if (typeof client.connect === 'function') {
    await client.connect();
  }
}

function isReady() {
  return ready && client && client.status === 'ready';
}

module.exports = { client, connect, isReady };
