'use strict';

const config = require('../config');
const { check } = require('../algorithms');
const { emit } = require('../events');

// Resolve a client identifier for a given request based on KEY_STRATEGY.
// The composite case just concatenates whatever is available.
function resolveId(strategy, req) {
  const apiKey = req.get('x-api-key') || null;
  const userId = (req.user && req.user.id) || req.get('x-user-id') || null;
  // req.socket.remoteAddress is the modern API; req.connection is a
  // deprecated alias that's been removed in newer Node versions.
  const ip = req.ip
    || (req.socket && req.socket.remoteAddress)
    || 'unknown';

  switch (strategy) {
    case 'apiKey':   return apiKey || `ip:${ip}`;
    case 'userId':   return userId || `ip:${ip}`;
    case 'composite':return [apiKey, userId, ip].filter(Boolean).join('|');
    case 'ip':
    default:         return ip;
  }
}

// Match the longest configured route prefix. Keys in ROUTES_JSON may be
// either a plain path prefix ("/api/search") which matches any method, or
// a method-qualified prefix ("POST /api/login") which is matched first.
// The longest matching prefix wins, so a more specific override beats a
// general one.
function resolveRouteConfig(method, reqPath) {
  const routes = config.routes;
  let best = null;
  let bestLen = -1;
  for (const [prefix, cfg] of Object.entries(routes)) {
    const fullMatch = `${method} ${reqPath}`.startsWith(prefix);
    const pathMatch = !prefix.includes(' ') && reqPath.startsWith(prefix);
    if ((fullMatch || pathMatch) && prefix.length > bestLen) {
      best = cfg;
      bestLen = prefix.length;
    }
  }
  return {
    algorithm: (best && best.algorithm) || config.algorithm,
    // Use != null (not truthy) so explicit 0 values from the override win
    // over the global default. The `||` would treat 0 as missing.
    limit:     (best && best.limit     != null) ? best.limit     : config.limit,
    windowMs:  (best && best.windowMs  != null) ? best.windowMs  : config.windowMs,
    burst:     (best && best.burst     != null) ? best.burst     : config.burst,
  };
}

// Return the longest matching route-prefix string (raw key) for a given
// request, or null when nothing matches. Used to derive a stable event
// scope from the configured overrides.
function matchedRoutePrefix(method, reqPath) {
  let best = null;
  let bestLen = -1;
  for (const prefix of Object.keys(config.routes)) {
    const fullMatch = `${method} ${reqPath}`.startsWith(prefix);
    const pathMatch = !prefix.includes(' ') && reqPath.startsWith(prefix);
    if ((fullMatch || pathMatch) && prefix.length > bestLen) {
      best = prefix;
      bestLen = prefix.length;
    }
  }
  return best;
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

// Build the middleware factory. `opts.scope` lets the caller force a
// specific scope label (used by the per-route mount in demo/api.js so the
// dashboard groups events by endpoint). When no explicit scope is given,
// the middleware derives one from the matched route prefix or, failing
// that, from method + path.
function rateLimiter(opts = {}) {
  const scope = opts.scope || null;

  return async function limiter(req, res, next) {
    const routeCfg = resolveRouteConfig(req.method, req.path);
    const id = resolveId(config.keyStrategy, req);

    // Pick a useful scope: explicit override wins, else the matched route
    // prefix from the config (so per-route overrides also produce
    // per-endpoint event groups), else fall back to method+path.
    let routeScope = scope;
    if (!routeScope) {
      const matchedPrefix = matchedRoutePrefix(req.method, req.path);
      routeScope = matchedPrefix || `${req.method} ${req.path}`;
    }

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

module.exports = { rateLimiter, resolveId, resolveRouteConfig, matchedRoutePrefix };
