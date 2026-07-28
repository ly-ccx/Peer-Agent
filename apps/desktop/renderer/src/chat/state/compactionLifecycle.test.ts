import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { reduceCompactionLifecycle } from './compactionLifecycle.ts';
import type { CompactionState } from './types.ts';

describe('compaction lifecycle', () => {
  it('keeps a new in-flight compaction when an older stream sends late idle', () => {
    const current: CompactionState = {
      phase: 'running',
      percent: 56,
      streamId: 'new-stream',
      startedAt: 20,
    };

    const next = reduceCompactionLifecycle(current, {
      stage: 'idle',
      streamId: 'old-stream',
    });

    assert.equal(next, current);
    assert.equal(next.phase, 'running');
    if (next.phase === 'running') assert.equal(next.percent, 56);
  });

  it('keeps a new in-flight compaction when an older completion timer settles', () => {
    const current: CompactionState = {
      phase: 'running',
      percent: 51,
      streamId: 'new-stream',
      startedAt: 20,
    };

    const next = reduceCompactionLifecycle(current, {
      stage: 'idle',
      streamId: 'old-stream',
    });

    assert.equal(next, current);
  });

  it('ignores finalizing from an older stream while a newer compaction is running', () => {
    const current: CompactionState = {
      phase: 'running',
      percent: 54,
      streamId: 'new-stream',
      startedAt: 20,
    };

    const next = reduceCompactionLifecycle(current, {
      stage: 'finalizing',
      streamId: 'old-stream',
      now: 30,
    });

    assert.equal(next, current);
  });

  it('preserves visible progress stage details when character percent is unavailable', () => {
    const started = reduceCompactionLifecycle({ phase: 'idle' }, {
      stage: 'start',
      streamId: 'stream-stage',
      now: 10,
    });
    const retrying = reduceCompactionLifecycle(started, {
      stage: 'progress',
      streamId: 'stream-stage',
      percent: null,
      progressStage: 'retrying',
      attempt: 2,
      maxAttempts: 3,
      inputTokenBudget: 21_532,
      now: 11,
    });

    assert.deepEqual(retrying, {
      phase: 'running',
      percent: null,
      progressStage: 'retrying',
      attempt: 2,
      maxAttempts: 3,
      inputTokenBudget: 21_532,
      streamId: 'stream-stage',
      startedAt: 10,
    });
  });

  it('transitions the matching stream through progress, finalizing, and idle', () => {
    const started = reduceCompactionLifecycle({ phase: 'idle' }, {
      stage: 'start',
      streamId: 'stream-1',
      now: 10,
    });
    const progressed = reduceCompactionLifecycle(started, {
      stage: 'progress',
      streamId: 'stream-1',
      percent: 56,
      now: 11,
    });
    const finalizing = reduceCompactionLifecycle(progressed, {
      stage: 'finalizing',
      streamId: 'stream-1',
      now: 12,
    });
    const settled = reduceCompactionLifecycle(finalizing, {
      stage: 'idle',
      streamId: 'stream-1',
    });

    assert.deepEqual(progressed, {
      phase: 'running',
      percent: 56,
      streamId: 'stream-1',
      startedAt: 10,
    });
    assert.deepEqual(finalizing, {
      phase: 'finalizing',
      percent: 100,
      streamId: 'stream-1',
      completedAt: 12,
    });
    assert.deepEqual(settled, { phase: 'idle' });
  });
});
