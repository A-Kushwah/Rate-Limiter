'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const configPath = path.join(__dirname, '..', 'src', 'config.js');

function loadConfig(overrides) {
  return spawnSync(process.execPath, ['-e', `require(${JSON.stringify(configPath)})`], {
    encoding: 'utf8',
    env: { ...process.env, ...overrides },
  });
}

test('invalid global window settings fail startup instead of disabling limiting', () => {
  const result = loadConfig({ WINDOW_MS: '0' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /WINDOW_MS must be a positive integer/);
});

test('invalid route limits fail startup instead of dropping all route overrides', () => {
  const result = loadConfig({
    ROUTES_JSON: JSON.stringify({ 'POST /login': { limit: 0 } }),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid limit for POST \/login/);
});

test('invalid Redis URLs are not copied into logs', () => {
  const secretMarker = 'redis-secret-marker';
  const result = loadConfig({ REDIS_URL: `not-a-redis-url-${secretMarker}` });
  assert.equal(result.status, 0);
  assert.ok(!result.stderr.includes(secretMarker));
});

test('host-run environment example uses localhost Redis while Compose uses its Redis service', () => {
  const envExample = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
  const compose = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.yml'), 'utf8');
  assert.match(envExample, /^REDIS_URL=redis:\/\/127\.0\.0\.1:6379$/m);
  assert.match(compose, /REDIS_URL:\s*"redis:\/\/redis:6379"/);
});
