'use strict';

const express = require('express');
const { rateLimiter } = require('../middleware/limiter');

const router = express.Router();

// In a real app these would be real handlers (DB lookups, auth checks). Here
// they're stubs that just return JSON so the focus stays on the limiter. The
// per-endpoint limit values are illustrative; the real config lives in
// ROUTES_JSON and can be changed without touching code.

router.get('/search', rateLimiter({ scope: 'GET /api/search' }), (req, res) => {
  res.json({
    endpoint: 'search',
    query: req.query.q || null,
    results: [`result-1 for ${req.query.q || ''}`, `result-2 for ${req.query.q || ''}`],
    ts: Date.now(),
  });
});

router.post('/login', rateLimiter({ scope: 'POST /api/login' }), (req, res) => {
  // Login is sensitive — a strict limit here is exactly the use case
  // interviewers ask about. (In a real system you'd also have captcha,
  // backoff, account lockout, etc.)
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
