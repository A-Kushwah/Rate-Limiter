'use strict';

// Load test using autocannon. Targets a running instance and reports
// requests/sec, latency, and how many got a 429.
//
// Usage:
//   node scripts/loadtest.js              # http://localhost:3000
//   node scripts/loadtest.js https://your-app.onrender.com
//
// The script sets a deliberately low limit via X-Forwarded-For is *not*
// used — we hammer a single client. To show the limiter doing its job,
// we configure the target with limit=10, burst=0 from the server side
// (set ALGORITHM=fixed-window LIMIT=10 BURST=0 WINDOW_MS=60000 in the
// env you point this at), then run this script and observe 429 responses.

const autocannon = require('autocannon');

const target = process.argv[2] || 'http://localhost:3000';
const path = '/api/search?q=test';
const connections = Number(process.env.CONNECTIONS || 50);
const duration = Number(process.env.DURATION || 10); // seconds
const pipelining = Number(process.env.PIPELINING || 1);

const instance = autocannon({
  url: `${target}${path}`,
  method: 'GET',
  connections,
  pipelining,
  duration,
  headers: { 'x-api-key': 'loadtest-client' },
}, (err, result) => {
  if (err) { console.error(err); process.exit(1); }

  const total = result.requests.sent;
  const twoxx = result['2xx'] || 0;
  const fourxx = result['4xx'] || 0;
  const blocked = Number(((result.statusCodeStats || {})['429'] || {}).count || 0);
  const ok = twoxx; // 200s; the demo endpoint never returns 2xx other than 200

  console.log('\n========= Load Test Report =========');
  console.log(`Target:           ${target}${path}`);
  console.log(`Duration:         ${Math.round(result.duration * 100) / 100}s`);
  console.log(`Connections:      ${connections}  (pipelining=${pipelining})`);
  console.log(`Total requests:   ${total}`);
  console.log(`HTTP 200:         ${ok}`);
  console.log(`HTTP 429:         ${blocked}`);
  console.log(`HTTP other 4xx:   ${Math.max(0, fourxx - blocked)}`);
  console.log(`HTTP 5xx:         ${result['5xx'] || 0}`);
  console.log(`Throughput:       ${result.requests.average} req/s (avg)`);
  console.log(`Latency p50:      ${result.latency.p50} ms`);
  console.log(`Latency p99:      ${result.latency.p99} ms`);
  console.log(`Errors:           ${result.errors}`);
  console.log(`Timeouts:         ${result.timeouts}`);
  console.log('====================================\n');

  // Sanity: with a low limit, the limiter MUST have blocked the majority.
  // If it didn't, something is broken.
  if (blocked === 0 || total === 0) {
    console.error('ERROR: No rate-limited 429 responses were observed.');
    console.error('       Start the server with ALGORITHM=fixed-window LIMIT=10 BURST=0');
    console.error('       to demonstrate the limiter holding the line.');
    process.exit(2);
  }
  process.exit(0);
});

// Stream progress so a long run doesn't look hung
autocannon.track(instance, { renderProgressBar: true, outputStream: process.stderr });
