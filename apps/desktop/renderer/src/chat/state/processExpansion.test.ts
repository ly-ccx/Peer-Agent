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
  it('keeps the process collapsed by default while active and stays collapsed when it completes', () => {
    const active = createProcessExpansionState(true);
    assert.equal(active.expanded, false);

    const completed = updateProcessActivity(active, false);
    assert.equal(completed.expanded, false);
  });

  it('does not reopen a process the user collapsed when streaming activity resumes', () => {
    const active = createProcessExpansionState(true);
    assert.equal(active.expanded, false);

    // 用户展开后又手动收起 → 后续流式活跃度变化不得把它自动展开。
    const opened = toggleProcessExpansion(active);
    assert.equal(opened.expanded, true);
    const collapsedAgain = toggleProcessExpansion(opened);
    assert.equal(collapsedAgain.expanded, false);

    const resumed = updateProcessActivity(collapsedAgain, true);
    assert.equal(resumed.expanded, false);
  });

  it('keeps a user-opened process open while streaming stays active', () => {
    const inactive = createProcessExpansionState(false);
    const opened = toggleProcessExpansion(inactive);
    assert.equal(opened.expanded, true);

    const active = updateProcessActivity(opened, true);
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
    assert.equal(expansion.expanded, false);

    const nextRoundActive = isProcessTimelineActive(nextToolRound, true);
    expansion = updateProcessActivity(expansion, nextRoundActive);
    assert.equal(nextRoundActive, true);
    assert.equal(expansion.expanded, false);

    expansion = updateProcessActivity(
      expansion,
      isProcessTimelineActive(nextToolRound, false),
    );
    assert.equal(expansion.expanded, false);
  });
});
