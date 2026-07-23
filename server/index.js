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

// Security headers, hand-rolled (no helmet dep). CSP is locked down: the
// dashboard loads Chart.js from jsdelivr CDN, everything else is same-origin.
function securityHeaders(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; " +
    "connect-src 'self' ws: wss:; " +
    "frame-ancestors 'none'"
  );
  next();
}

// Tiny in-process rate limiter for the /config mutation endpoint so an
// attacker can't thrash the in-memory algorithm state.
function configRateLimit() {
  const hits = new Map(); // ip -> { count, resetAt }
  const WINDOW_MS = 60_000;
  const LIMIT = 10;
  return (req, res, next) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const entry = hits.get(ip);
    if (!entry || entry.resetAt < now) {
      hits.set(ip, { count: 1, resetAt: now + WINDOW_MS });
      return next();
    }
    if (entry.count >= LIMIT) {
      const retry = Math.ceil((entry.resetAt - now) / 1000);
      res.set('Retry-After', String(retry));
      return res.status(429).json({ error: 'too_many_config_changes' });
    }
    entry.count++;
    next();
  };
}

async function main() {
  // Redis has to be available before the limiter can do its job, but I
  // still want the health endpoint and dashboard to come up even if Redis
  // is down for a bit.
  try {
    await connectRedis();
    await loadScripts();
    console.log('[boot] Redis ready, Lua scripts loaded');
  } catch (err) {
    console.error('[boot] Redis unavailable at startup:', err.message);
  }

  const app = express();
  // Trust the first hop in front of us (Render, Heroku, Fly all sit one
  // hop away). `true` would trust any client-supplied X-Forwarded-For,
  // which is spoofable on the open internet.
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '32kb' }));
  app.use(securityHeaders);
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
  app.post('/config', configRateLimit(), (req, res) => {
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
      res.set('Cache-Control', 'no-cache');
      res.sendFile(path.resolve(__dirname, '..', 'src/dashboard/index.html'));
    });
  }

  // --- Demo API (rate-limited) ---
  // A single limiter mounted at /api handles every route. Leaving `scope`
  // unset makes it fall back to `${req.method} ${req.path}` per request, so
  // each endpoint gets its own bucket and its own ROUTES_JSON override is
  // resolved correctly (see resolveRouteConfig). Routes that aren't listed
  // in ROUTES_JSON still get bounded by the global defaults.
  //
  // NOTE: individual routes in demoApi used to also wrap themselves with
  // rateLimiter(...). That meant every request was counted twice (once
  // here, once again inside the route) against two different scope keys,
  // and the dashboard showed duplicate events per request. The per-route
  // wrapping has been removed — this single middleware is now the only
  // rate limiter in the request path.
  app.use('/api', rateLimiter());
  app.use('/api', demoApi);

  // --- Error handler (last) ---
  app.use((err, req, res, _next) => {
    // express.json() throws a SyntaxError (status 400) for malformed JSON
    // and a PayloadTooLargeError (status 413) for oversized bodies. Honor
    // whatever status body-parser set instead of masking it as a 500.
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600
      ? err.status
      : 500;
    if (status >= 500) console.error('[unhandled]', err);
    res.status(status).json({ error: status >= 500 ? 'internal_error' : 'bad_request' });
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

  // Re-load the scripts if Redis comes back after a restart or blip.
  redis.on('ready', async () => {
    try { await loadScripts(); } catch (e) { console.error('re-load scripts:', e.message); }
  });

  const host = process.env.HOST || '0.0.0.0';
  server.listen(config.port, host, () => {
    console.log(`[boot] listening on ${host}:${config.port} (algo=${config.algorithm})`);
  });

  server.on('error', (err) => {
    console.error('[server] failed to start:', err.message);
    process.exit(1);
  });

  // Graceful shutdown so a deploy or restart does not leave requests hanging.
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
