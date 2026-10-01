'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { rateLimiter } = require('../src/middleware/limiter');

function createRequest() {
  return {
    method: 'GET',
    originalUrl: '/api/search',
    path: '/api/search',
    baseUrl: '/api',
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    get: () => null,
  };
}

function createResponse() {
  const headers = {};
  const response = {
    headers,
    statusCode: 200,
    body: null,
    set(name, value) {
      headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  return response;
}

test('rate limiter returns 503 and does not pass requests when its check fails', async () => {
  const originalError = console.error;
  console.error = () => {};
  const response = createResponse();
  let nextCalled = false;

  try {
    await rateLimiter({}, async () => {
      throw new Error('Redis unavailable');
    })(createRequest(), response, () => { nextCalled = true; });
  } finally {
    console.error = originalError;
  }

  assert.equal(response.statusCode, 503);
  assert.equal(response.headers['X-RateLimit-Error'], 'limiter-unavailable');
  assert.deepEqual(response.body, {
    error: 'rate_limiter_unavailable',
    message: 'The request could not be checked against the rate limit.',
  });
  assert.equal(nextCalled, false);
});

test('rate limiter returns 429 and does not pass requests over the configured limit', async () => {
  const response = createResponse();
  let nextCalled = false;

  await rateLimiter({}, async () => ({
    allowed: false,
    remaining: 0,
    resetAt: Date.now() + 1000,
    retryAfterMs: 1000,
  }))(createRequest(), response, () => { nextCalled = true; });

  assert.equal(response.statusCode, 429);
  assert.equal(response.headers['Retry-After'], '1');
  assert.equal(response.body.error, 'Too Many Requests');
  assert.equal(nextCalled, false);
});

test('rate limiter passes requests when the check allows them', async () => {
  const response = createResponse();
  let nextCalled = false;

  await rateLimiter({}, async () => ({
    allowed: true,
    remaining: 1,
    resetAt: Date.now() + 1000,
    retryAfterMs: 0,
  }))(createRequest(), response, () => { nextCalled = true; });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['X-RateLimit-Remaining'], '1');
  assert.equal(nextCalled, true);
});
