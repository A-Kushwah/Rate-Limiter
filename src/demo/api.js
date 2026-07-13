'use strict';

const express = require('express');
const { rateLimiter } = require('../middleware/limiter');

const router = express.Router();

// These are just stand-ins for real handlers. The point here is the limiter,
// not the business logic. The per-endpoint limits are configurable through
// ROUTES_JSON so they can be adjusted without changing the code.

router.get('/search', rateLimiter({ scope: 'GET /api/search' }), (req, res) => {
  res.json({
    endpoint: 'search',
    query: req.query.q || null,
    results: [`result-1 for ${req.query.q || ''}`, `result-2 for ${req.query.q || ''}`],
    ts: Date.now(),
  });
});

router.post('/login', rateLimiter({ scope: 'POST /api/login' }), (req, res) => {
  // Login is one of the easier places to justify a stricter limit.
  // In a real system I'd also add captcha, backoff, or account lockout,
  // but this is enough to show the behavior.
  res.json({ ok: true, token: 'demo-' + Math.random().toString(36).slice(2), ts: Date.now() });
});

router.get('/me', rateLimiter({ scope: 'GET /api/me' }), (req, res) => {
  res.json({
    id: 'demo-user',
    plan: 'free',
    quota: 'see X-RateLimit-Remaining',
  });
});

router.get('/expensive', rateLimiter({ scope: 'GET /api/expensive' }), (req, res) => {
  // Simulate work
  res.json({ computed: Math.random(), ts: Date.now() });
});

module.exports = router;
