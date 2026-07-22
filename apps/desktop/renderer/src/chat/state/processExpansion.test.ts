import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createProcessExpansionState,
  isProcessTimelineActive,
  toggleProcessExpansion,
  updateProcessActivity,
} from './processExpansion.ts';
import type { SegmentGroup } from './types.ts';

describe('process expansion state', () => {
  it('keeps an active process visible by default and auto-collapses when it completes', () => {
    const active = createProcessExpansionState(true);
    assert.equal(active.expanded, true);

    const completed = updateProcessActivity(active, false);
    assert.equal(completed.expanded, false);
  });

  it('does not reopen a process the user collapsed when streaming activity resumes', () => {
    const active = createProcessExpansionState(true);
    const collapsed = toggleProcessExpansion(active);
    assert.equal(collapsed.expanded, false);

    const temporarilyInactive = updateProcessActivity(collapsed, false);
    const streamingAgain = updateProcessActivity(temporarilyInactive, true);
    assert.equal(streamingAgain.expanded, false);
  });

  it('opens a newly active process when the user has not overridden it', () => {
    const inactive = createProcessExpansionState(false);
    const active = updateProcessActivity(inactive, true);
    assert.equal(active.expanded, true);
  });

  it('keeps one stable process timeline across commentary between tool rounds', () => {
    const commentaryBetweenTools: SegmentGroup[] = [
      { type: 'thinking', content: 'inspect the repository' },
      {
        type: 'tool-call-group',
        calls: [{ tool: 'bash', args: {}, result: 'ok' }],
      },
      { type: 'text', content: 'The first check passed; now inspect the next file.' },
    ];
    const nextToolRound: SegmentGroup[] = [
      ...commentaryBetweenTools,
      { type: 'thinking', content: 'prepare the next command' },
    ];

    let expansion = createProcessExpansionState(true);
    const commentaryActive = isProcessTimelineActive(commentaryBetweenTools, true);
    expansion = updateProcessActivity(expansion, commentaryActive);
    assert.equal(commentaryActive, true);
    assert.equal(expansion.expanded, true);

    const nextRoundActive = isProcessTimelineActive(nextToolRound, true);
    expansion = updateProcessActivity(expansion, nextRoundActive);
    assert.equal(nextRoundActive, true);
    assert.equal(expansion.expanded, true);

    expansion = updateProcessActivity(
      expansion,
      isProcessTimelineActive(nextToolRound, false),
    );
    assert.equal(expansion.expanded, false);
  });
});
