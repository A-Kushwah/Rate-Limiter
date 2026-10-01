'use strict';

function configRateLimit({ maxEntries = 10_000 } = {}) {
  const hits = new Map();
  const WINDOW_MS = 60_000;
  const LIMIT = 10;

  return (req, res, next) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const entry = hits.get(ip);
    if (!entry || entry.resetAt <= now) {
      if (entry) hits.delete(ip);
      if (hits.size >= maxEntries) {
        const oldestIp = hits.keys().next().value;
        if (oldestIp !== undefined) hits.delete(oldestIp);
      }
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

module.exports = { configRateLimit };
