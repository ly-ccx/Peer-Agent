import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCircuitBreaker } from './circuit-breaker.mjs';

test('five failed turns open a durable ten-minute circuit and one manual trial closes it', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'peer-breaker-')); let clock = Date.parse('2026-10-01T00:00:00Z');
  const options = { rootDir, workspaceId: 'ws', now: () => new Date(clock).toISOString() };
  try {
    const breaker = createCircuitBreaker(options);
    for (let n = 0; n < 5; n++) {
      assert.equal(breaker.admit().allowed, true);
      assert.equal(breaker.failure({ turnId: `t${n}`, reason: 'provider failed' }).opened, n === 4);
    }
    assert.equal(breaker.admit().allowed, false);
    assert.equal(breaker.failure({ turnId: 't4' }).replayed, true);
    const restarted = createCircuitBreaker(options);
    assert.equal(restarted.state().failures, 5);
    assert.equal(restarted.admit().allowed, false);
    assert.equal(restarted.admit({ manual: true }).allowed, true);
    assert.equal(restarted.admit().allowed, false);
    restarted.success();
    assert.equal(restarted.state().failures, 0); assert.equal(restarted.admit().allowed, true);
    for (let n = 0; n < 5; n++) restarted.failure({ turnId: `again${n}` });
    clock += 10 * 60_000 - 1; assert.equal(restarted.admit().allowed, false);
    clock++; assert.equal(restarted.admit().allowed, true); assert.equal(restarted.admit().allowed, false);
    assert.equal(restarted.failure({ turnId: 'trial' }).opened, true);
    assert.equal(restarted.admit().allowed, false);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});
