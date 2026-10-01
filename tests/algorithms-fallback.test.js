'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { client } = require('../src/redis');
const { evalScript } = require('../src/algorithms');

test('EVALSHA cache misses fall back to EVAL with the script source', async () => {
  const originalEvalsha = client.evalsha;
  const originalEval = client.eval;
  let evalCalls = 0;
  client.evalsha = async () => {
    throw new Error('NOSCRIPT No matching script');
  };
  client.eval = async (script, numKeys, key, value) => {
    evalCalls++;
    assert.equal(typeof script, 'string');
    assert.equal(numKeys, 1);
    assert.equal(key, 'test-key');
    assert.equal(value, 'test-value');
    return 'evaluated';
  };
  try {
    const result = await evalScript('fixed-window', 1, 'test-key', 'test-value');
    assert.equal(result, 'evaluated');
    assert.equal(evalCalls, 1);
  } finally {
    client.evalsha = originalEvalsha;
    client.eval = originalEval;
  }
});

test('non-NOSCRIPT errors are not masked by EVAL fallback', async () => {
  const originalEvalsha = client.evalsha;
  const originalEval = client.eval;
  let evalCalls = 0;
  client.evalsha = async () => {
    throw new Error('ERR simulated Redis failure');
  };
  client.eval = async () => {
    evalCalls++;
  };
  try {
    await assert.rejects(
      evalScript('fixed-window', 1, 'test-key'),
      /ERR simulated Redis failure/
    );
    assert.equal(evalCalls, 0);
  } finally {
    client.evalsha = originalEvalsha;
    client.eval = originalEval;
  }
});
