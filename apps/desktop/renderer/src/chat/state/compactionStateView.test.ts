import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { CompactionState } from './types.ts';
import {
  compactionProgressPercent,
  compactionStateLabel,
  sidebarCompactionStateLabel,
  sidebarConversationActivity,
} from './compactionStateView.ts';

const running: CompactionState = { phase: 'running', percent: 51, streamId: 's1', startedAt: 1 };
const finalizing: CompactionState = { phase: 'finalizing', percent: 100, streamId: 's1', completedAt: 2 };
const failed: CompactionState = { phase: 'failed', percent: 100, streamId: 's1', error: 'reload failed', failedAt: 3 };

describe('compactionStateView', () => {
  it('shows compaction ahead of running for sidebar activity', () => {
    assert.deepEqual(sidebarConversationActivity({ isRunning: true, compactionState: running }), {
      kind: 'compaction',
      state: running,
    });
  });

  it('falls back to running only when compaction is idle or missing', () => {
    assert.deepEqual(sidebarConversationActivity({ isRunning: true, compactionState: { phase: 'idle' } }), {
      kind: 'running',
    });
    assert.deepEqual(sidebarConversationActivity({ isRunning: false, compactionState: undefined }), {
      kind: 'idle',
    });
  });

  it('keeps finalizing and failed states visible with progress', () => {
    assert.equal(compactionProgressPercent(finalizing), 100);
    assert.equal(compactionProgressPercent(failed), 100);
    assert.equal(compactionProgressPercent({ phase: 'idle' }), null);
  });

  it('labels running, finalizing, and failed states for surface and sidebar', () => {
    assert.equal(compactionStateLabel(running, true), '压缩上下文中');
    assert.equal(compactionStateLabel(finalizing, true), '刷新上下文中');
    assert.equal(compactionStateLabel(failed, false), 'Compaction failed');
    assert.equal(sidebarCompactionStateLabel(finalizing, true), '刷新上下文');
  });
});
