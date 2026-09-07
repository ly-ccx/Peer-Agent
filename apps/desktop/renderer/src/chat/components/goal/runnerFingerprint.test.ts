import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runnerFingerprint } from './runnerFingerprint.ts';

for (const status of ['queued', 'running', 'completed', 'failed', 'cancelled']) {
  it(`detects explorer-only updates: ${status}`, () => {
    const before = { status: 'exploring', explorers: [{ explorerId: 'e1', status: 'queued' }] };
    const after = { ...before, explorers: [{ explorerId: 'e1', status, updatedAt: '2026-09-05' }] };
    assert.notEqual(runnerFingerprint(before), runnerFingerprint(after));
    assert.equal(runnerFingerprint(after), runnerFingerprint(structuredClone(after)));
  });
}

describe('runnerFingerprint (P1 dual-channel dedupe)', () => {
  it('treats equivalent runner snapshots as equal', () => {
    const a = {
      status: 'running',
      phase: 'act',
      enabled: true,
      roundCount: 3,
      toolCallCount: 7,
      intent: 'execute',
      currentTaskId: 't1',
      lastTickAt: '2026-01-01T00:00:00.000Z',
      lastError: null,
      extraNoise: { foo: 1 },
    };
    const b = {
      ...a,
      extraNoise: { foo: 2 },
      unrelated: true,
    };
    assert.equal(runnerFingerprint(a), runnerFingerprint(b));
  });

  it('changes when progress counters move', () => {
    const base = {
      status: 'running',
      phase: 'act',
      enabled: true,
      roundCount: 1,
      toolCallCount: 1,
    };
    assert.notEqual(
      runnerFingerprint(base),
      runnerFingerprint({ ...base, roundCount: 2 }),
    );
  });
});
