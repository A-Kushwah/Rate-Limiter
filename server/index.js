'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const morgan = require('morgan');
const { WebSocketServer } = require('ws');

const config = require('../src/config');
const { client: redis, connect: connectRedis, isReady: redisReady } = require('../src/redis');
const { loadScripts } = require('../src/algorithms');
const { rateLimiter } = require('../src/middleware/limiter');
const { subscribe, snapshot } = require('../src/events');
const demoApi = require('../src/demo/api');

async function main() {
  // Redis must be up before we can load scripts. If it's not, we still
  // start the HTTP server (so /health can report degraded) but every
  // request will fail open with an X-RateLimit-Error header.
  try {
    await connectRedis();
    await loadScripts();
    console.log('[boot] Redis ready, Lua scripts loaded');
  } catch (err) {
    console.error('[boot] Redis unavailable at startup:', err.message);
  }

  const app = express();
  app.set('trust proxy', true); // honour X-Forwarded-For from Render/Railway
  app.use(express.json());
  app.use(morgan(config.nodeEnv === 'production' ? 'tiny' : 'dev'));

  // --- Health & config (unprotected, no limiter) ---
  app.get('/health', (req, res) => {
    res.json({
      ok: true,
      redis: redisReady() ? 'ready' : 'down',
      algorithm: config.algorithm,
      uptimeSec: Math.round(process.uptime()),
    });
  });

  app.get('/config', (req, res) => {
    res.json({
      algorithm: config.algorithm,
      windowMs: config.windowMs,
      limit: config.limit,
      burst: config.burst,
      keyStrategy: config.keyStrategy,
      routes: config.routes,
    });
  });

  // Allow the dashboard's algorithm dropdown to actually change behaviour
  // without a deploy. Updates the in-memory config — does not persist.
  app.post('/config', (req, res) => {
    const { algorithm } = req.body || {};
    if (algorithm && config.algorithms.includes(algorithm)) {
      config.algorithm = algorithm;
      return res.json({ ok: true, algorithm: config.algorithm });
    }
    res.status(400).json({ error: 'invalid algorithm' });
  });

  // --- Dashboard (static) ---
  if (config.dashboardEnabled) {
    app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, '..', 'src/dashboard/index.html'));
    });
  }

  // --- Demo API (rate-limited) ---
  // Apply a global limiter at /api so unconfigured routes are still bounded
  // by the default config. Per-route overrides inside the router take
  // precedence.
  app.use('/api', rateLimiter({ scope: 'GLOBAL /api' }));
  app.use('/api', demoApi);

  // --- Error handler (last) ---
  app.use((err, req, res, _next) => {
    console.error('[unhandled]', err);
    res.status(500).json({ error: 'internal_error' });
  });

  const server = http.createServer(app);

  // --- WebSocket for the dashboard ---
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    // Replay recent events so a freshly-loaded dashboard isn't empty.
    for (const evt of snapshot()) {
      try { ws.send(JSON.stringify(evt)); } catch {}
    }
    // No client->server messages needed; the dashboard is read-only here.
  });

  // Fan out limiter events to all connected WS clients.
  subscribe((evt) => {
    const msg = JSON.stringify(evt);
    for (const ws of wss.clients) {
      if (ws.readyState === 1) {
        try { ws.send(msg); } catch {}
      }
    }
  });

  // Soft-restart the WebSocket server if Redis comes back. Cheap reconnect.
  redis.on('ready', async () => {
    try { await loadScripts(); } catch (e) { console.error('re-load scripts:', e.message); }
  });

  server.listen(config.port, () => {
    console.log(`[boot] listening on :${config.port} (algo=${config.algorithm})`);
  });

  // Graceful shutdown so Render/Railway don't SIGKILL mid-request.
  const shutdown = (sig) => () => {
    console.log(`[shutdown] ${sig}`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.on('SIGINT', shutdown('SIGINT'));
  process.on('SIGTERM', shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
