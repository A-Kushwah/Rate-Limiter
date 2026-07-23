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

// Find the most specific configured route entry for a request. ROUTES_JSON
// keys can be either "METHOD /path" (e.g. "POST /api/login") or a bare path
// prefix (e.g. "/api/admin", which applies to any method). We try an exact
// "METHOD /path" match first, then fall back to the longest matching prefix
// among both forms. (Exported for unit testing without a live request.)
function matchedRoutePrefix(method, reqPath) {
  const routes = config.routes;
  const methodPath = `${method} ${reqPath}`;

  // 1. Exact "METHOD /path" match wins outright.
  if (routes[methodPath]) return methodPath;

  // 2. Longest-prefix match, considering "METHOD /prefix" keys (matched
  //    against `${method} ${reqPath}`) and bare "/prefix" keys (matched
  //    against `reqPath` only, so they apply across all methods).
  let best = null;
  let bestLen = -1;
  for (const prefix of Object.keys(routes)) {
    const hasMethod = prefix.includes(' ');
    const candidate = hasMethod ? methodPath : reqPath;
    if (candidate.startsWith(prefix) && prefix.length > bestLen) {
      best = prefix;
      bestLen = prefix.length;
    }
  }
  return best;
}

// Merge the matched route override (if any) on top of the global defaults.
function resolveRouteConfig(method, reqPath) {
  const routes = config.routes;
  const prefix = matchedRoutePrefix(method, reqPath);
  const best = prefix ? routes[prefix] : null;
  return {
    algorithm: (best && best.algorithm) || config.algorithm,
    // Use != null (not `||`) so an explicit override of 0 (e.g. burst: 0
    // for login) isn't discarded in favor of the global default — `||`
    // treats 0 as falsy and would silently ignore it.
    limit:     (best && best.limit    != null) ? best.limit    : config.limit,
    windowMs:  (best && best.windowMs != null) ? best.windowMs : config.windowMs,
    burst:     (best && best.burst    != null) ? best.burst    : config.burst,
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

// Cap how much of the raw request path we'll use to build a scope/Redis-key.
// Without this, an attacker can hit /api/<random-unique-string> repeatedly
// and force the app to create an unbounded number of distinct rate-limit
// buckets in Redis — a cheap key-space/memory exhaustion DoS, since scope
// is derived straight from client-controlled input (the URL path).
const MAX_SCOPE_PATH_LEN = 200;

function safeScopePath(fullPath) {
  return fullPath.length > MAX_SCOPE_PATH_LEN
    ? fullPath.slice(0, MAX_SCOPE_PATH_LEN)
    : fullPath;
}

// Build the middleware factory. When no explicit scope is given,
// the middleware derives one from the matched route prefix or, failing
// that, from method + path.
function rateLimiter(opts = {}) {
  const explicitScope = opts.scope || null;

  return async function limiter(req, res, next) {
    const fullPath = req.originalUrl ? req.originalUrl.split('?')[0] : req.path;
    const routeCfg = resolveRouteConfig(req.method, fullPath);
    const id = resolveId(config.keyStrategy, req);

    let routeScope = explicitScope;
    if (!routeScope) {
      const matchedPrefix = matchedRoutePrefix(req.method, fullPath);
      routeScope = matchedPrefix || `${req.method} ${safeScopePath(fullPath)}`;
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
