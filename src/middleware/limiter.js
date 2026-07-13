'use strict';

const config = require('../config');
const { check } = require('../algorithms');
const { emit } = require('../events');

// Resolve a client identifier for a given request based on KEY_STRATEGY.
// `composite` joins whatever's available with a separator Redis keys tolerate.
function resolveId(strategy, req) {
  const apiKey = req.get('x-api-key') || null;
  const userId = (req.user && req.user.id) || req.get('x-user-id') || null;
  // Express's `req.ip` requires `app.set('trust proxy', ...)` to be honest
  // about the originating IP behind a load balancer. We do that in server.js.
  const ip = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';

  switch (strategy) {
    case 'apiKey':   return apiKey || `ip:${ip}`;
    case 'userId':   return userId || `ip:${ip}`;
    case 'composite':return [apiKey, userId, ip].filter(Boolean).join('|');
    case 'ip':
    default:         return ip;
  }
}

// Match the longest configured route prefix. More specific overrides win.
// Returns the merged config (route-specific overrides applied on top of
// global defaults).
function resolveRouteConfig(reqPath) {
  const routes = config.routes;
  let best = null;
  let bestLen = -1;
  for (const [prefix, cfg] of Object.entries(routes)) {
    if (reqPath.startsWith(prefix) && prefix.length > bestLen) {
      best = cfg;
      bestLen = prefix.length;
    }
  }
  return {
    algorithm: (best && best.algorithm) || config.algorithm,
    limit:     (best && best.limit)     || config.limit,
    windowMs:  (best && best.windowMs)  || config.windowMs,
    burst:     (best && best.burst)     || config.burst,
  };
}

function setRateLimitHeaders(res, result, opts) {
  res.set('X-RateLimit-Limit', String(opts.limit));
  res.set('X-RateLimit-Remaining', String(Math.max(0, result.remaining)));
  res.set('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));
  if (!result.allowed && result.retryAfterMs > 0) {
    // Retry-After per RFC 7231: seconds (integer) preferred.
    res.set('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
  }
}

// Build the middleware factory. `routeOverride` lets the demo app mount the
// limiter with a fixed scope like "GET /login" rather than re-deriving it
// from req — cleaner and faster on the hot path.
function rateLimiter(opts = {}) {
  const scope = opts.scope || '__default__';

  return async function limiter(req, res, next) {
    const routeCfg = resolveRouteConfig(req.path);
    const id = resolveId(config.keyStrategy, req);
    const routeScope = opts.scope || `${req.method} ${req.path}`;

    const startedAt = Date.now();
    let result;
    try {
      result = await check(routeCfg.algorithm, routeScope, id, {
        limit: routeCfg.limit,
        windowMs: routeCfg.windowMs,
        burst: routeCfg.burst,
      });
    } catch (err) {
      // Limiter itself is broken. Fail open: log it, allow the request,
      // tag the response so it's visible in logs. In a stricter deployment
      // you would fail closed here.
      console.error('[limiter] error, failing open:', err.message);
      res.set('X-RateLimit-Error', 'limiter-unavailable');
      return next();
    }

    setRateLimitHeaders(res, result, routeCfg);

    // Emit a dashboard event. The events module is a no-op stub if WS isn't
    // wired (e.g. in unit tests).
    emit({
      type: result.allowed ? 'allowed' : 'blocked',
      algorithm: routeCfg.algorithm,
      route: routeScope,
      id,
      limit: routeCfg.limit,
      remaining: result.remaining,
      at: startedAt,
      latencyMs: Date.now() - startedAt,
    });

    if (!result.allowed) {
      res.status(429).json({
        error: 'Too Many Requests',
        message: `Rate limit exceeded for ${routeScope}`,
        limit: routeCfg.limit,
        windowMs: routeCfg.windowMs,
        retryAfterMs: result.retryAfterMs,
      });
      return;
    }
    next();
  };
}

module.exports = { rateLimiter, resolveId, resolveRouteConfig };
