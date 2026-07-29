import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  beginCompaction,
  endCompaction,
  failCompaction,
  getCompaction,
  updateCompactionProgress,
  __resetCompactionRegistry,
} from './compaction-registry.mjs';

describe('compaction registry', () => {
  afterEach(() => {
    __resetCompactionRegistry();
  });

  it('returns null for unknown conversation', () => {
    assert.equal(getCompaction('missing'), null);
    assert.equal(getCompaction(null), null);
    assert.equal(getCompaction(undefined), null);
  });

  it('tracks begin -> progress -> get lifecycle per conversation', () => {
    beginCompaction({ conversationId: 'c1', streamId: 's1', manual: true });
    assert.deepEqual(getCompaction('c1'), {
      compacting: true,
      streamId: 's1',
      percent: null,
      manual: true,
    });

    updateCompactionProgress({ conversationId: 'c1', streamId: 's1', percent: 42 });
    assert.equal(getCompaction('c1').percent, 42);
  });

  it('isolates state between conversations', () => {
    beginCompaction({ conversationId: 'c1', streamId: 's1', manual: false });
    beginCompaction({ conversationId: 'c2', streamId: 's2', manual: true });

    assert.equal(getCompaction('c1').streamId, 's1');
    assert.equal(getCompaction('c1').manual, false);
    assert.equal(getCompaction('c2').streamId, 's2');
    assert.equal(getCompaction('c2').manual, true);

    endCompaction({ conversationId: 'c1', streamId: 's1' });
    assert.equal(getCompaction('c1'), null);
    // c2 unaffected.
    assert.equal(getCompaction('c2').streamId, 's2');
  });

  it('ignores progress and end from a stale streamId', () => {
    beginCompaction({ conversationId: 'c1', streamId: 's-new', manual: false });

    // Stale progress must not overwrite the active entry.
    updateCompactionProgress({ conversationId: 'c1', streamId: 's-old', percent: 99 });
    assert.equal(getCompaction('c1').percent, null);

    // Stale end must not clear the active entry.
    endCompaction({ conversationId: 'c1', streamId: 's-old' });
    assert.equal(getCompaction('c1').streamId, 's-new');

    // Matching end clears it.
    endCompaction({ conversationId: 'c1', streamId: 's-new' });
    assert.equal(getCompaction('c1'), null);
  });

  it('preserves a failed terminal state until retry or explicit clear', () => {
    beginCompaction({ conversationId: 'c1', streamId: 's1', manual: false });
    failCompaction({
      conversationId: 'c1',
      streamId: 's1',
      errorCode: 'CONTEXT_COMPACTION_INSUFFICIENT_REDUCTION',
      message: 'minimal candidate is above target',
      budget: { minimalCandidateTokens: 207_428, requestTarget: 206_400 },
    });
    const failed = getCompaction('c1');
    assert.equal(failed.compacting, false);
    assert.equal(failed.phase, 'failed');
    assert.equal(failed.errorCode, 'CONTEXT_COMPACTION_INSUFFICIENT_REDUCTION');
    assert.equal(failed.budget.minimalCandidateTokens, 207_428);

    beginCompaction({ conversationId: 'c1', streamId: 's2', manual: false });
    assert.equal(getCompaction('c1').compacting, true);
  });

  it('end without streamId clears unconditionally (fallback)', () => {
    beginCompaction({ conversationId: 'c1', streamId: 's1', manual: false });
    endCompaction({ conversationId: 'c1' });
    assert.equal(getCompaction('c1'), null);
  });

  it('re-begin on same conversation replaces prior entry', () => {
    beginCompaction({ conversationId: 'c1', streamId: 's1', manual: false });
    updateCompactionProgress({ conversationId: 'c1', streamId: 's1', percent: 50 });
    beginCompaction({ conversationId: 'c1', streamId: 's2', manual: true });

    const entry = getCompaction('c1');
    assert.equal(entry.streamId, 's2');
    assert.equal(entry.percent, null);
    assert.equal(entry.manual, true);
  });

  it('ignores begin with missing identifiers', () => {
    beginCompaction({ conversationId: '', streamId: 's1' });
    beginCompaction({ conversationId: 'c1', streamId: '' });
    assert.equal(getCompaction('c1'), null);
  });
});
