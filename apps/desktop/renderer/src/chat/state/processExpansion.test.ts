import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createProcessExpansionState,
  toggleProcessExpansion,
  updateProcessActivity,
} from './processExpansion.ts';

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
});
