import test from 'node:test';
import assert from 'node:assert/strict';
import * as timers from 'node:timers';
import { observeGc } from './gc-observation.mjs';

test('GC observer aligns timestamps, flushes pending records and disconnects idempotently', () => {
  let callback, disconnected = false, tick = 100;
  class Observer {
    static supportedEntryTypes = ['gc'];
    constructor(fn) { callback = fn; }
    observe(options) { assert.deepEqual(options, { entryTypes: ['gc'] }); }
    takeRecords() { return [{ startTime: 20, duration: 3, detail: { kind: 1, flags: 0 } }]; }
    disconnect() { disconnected = true; }
  }
  const observation = observeGc({ PerformanceObserver: Observer, performance: { now: () => 10 },
    now: () => tick++, wall: () => 'fixture', timers }, 1000);
  callback({ getEntries: () => [{ startTime: 15, duration: 2, detail: { kind: 1, flags: 0 } }] });
  const result = observation.stop();
  assert.equal(result.entries[0].startMono, 105.5);
  assert.equal(result.entries[1].startMono, 110.5);
  assert.equal(result.uncertaintyMs, .5); assert.equal(disconnected, true);
  assert.equal(observation.stop().entries.length, 2);
});
