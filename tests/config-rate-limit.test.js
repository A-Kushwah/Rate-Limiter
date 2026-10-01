'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { configRateLimit } = require('../src/middleware/config-rate-limit');

function request(limiter, ip) {
  let nextCalled = false;
  let statusCode;
  const req = { ip };
  const res = {
    set() { return this; },
    status(code) {
      statusCode = code;
      return this;
    },
    json() { return this; },
  };
  limiter(req, res, () => { nextCalled = true; });
  return { nextCalled, statusCode };
}

test('config rate limiter bounds tracked client entries', () => {
  const limiter = configRateLimit({ maxEntries: 2 });
  for (let i = 0; i < 10; i++) request(limiter, 'first');
  request(limiter, 'second');
  request(limiter, 'third');

  const firstAfterEviction = request(limiter, 'first');
  assert.equal(firstAfterEviction.nextCalled, true);
  assert.equal(firstAfterEviction.statusCode, undefined);
});
