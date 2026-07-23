'use strict';

const express = require('express');

const router = express.Router();

// These are stand-ins for real handlers. Rate limiting is enforced by the
// global /api middleware in server/index.js, which already resolves the
// most specific override from ROUTES_JSON. The per-route paths here just
// need to exist so the global prefix matcher produces a stable scope for
// the dashboard event log.

router.get('/search', (req, res) => {
  res.json({
    endpoint: 'search',
    query: req.query.q || null,
    results: [`result-1 for ${req.query.q || ''}`, `result-2 for ${req.query.q || ''}`],
    ts: Date.now(),
  });
});

router.post('/login', (req, res) => {
  // Login is one of the easier places to justify a stricter limit.
  // In a real system I'd also add captcha, backoff, or account lockout,
  // but this is enough to show the behavior.
  res.json({ ok: true, token: 'demo-' + Math.random().toString(36).slice(2), ts: Date.now() });
});

router.get('/me', (req, res) => {
  res.json({
    id: 'demo-user',
    plan: 'free',
    quota: 'see X-RateLimit-Remaining',
  });
});

router.get('/expensive', (req, res) => {
  // Simulate work
  res.json({ computed: Math.random(), ts: Date.now() });
});

module.exports = router;
