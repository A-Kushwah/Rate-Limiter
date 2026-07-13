'use strict';

// Tiny pub/sub for live dashboard events. WebSocket server subscribes;
// middleware publishes. Module-level singleton, no need for a bus.

let subscribers = new Set();
let buffer = []; // ring buffer of recent events for late-joining clients
const BUFFER_MAX = 200;

function subscribe(fn) {
  subscribers.add(fn);
  // Replay buffered events to the new subscriber so a page reload shows the
  // recent history instead of an empty chart.
  for (const evt of buffer) fn(evt);
  return () => subscribers.delete(fn);
}

function emit(evt) {
  buffer.push(evt);
  if (buffer.length > BUFFER_MAX) buffer.shift();
  for (const fn of subscribers) {
    try { fn(evt); } catch (e) { /* ignore subscriber errors */ }
  }
}

function snapshot() {
  return buffer.slice();
}

module.exports = { subscribe, emit, snapshot };
