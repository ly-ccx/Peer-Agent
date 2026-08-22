import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskOverviewItem } from '@peer-agent/protocol';
import { countWorkbenchInbox } from './workbenchInboxCounts.ts';

function item(
  actionRight: TaskOverviewItem['actionRight'],
  source: TaskOverviewItem['source'] = 'goal_plan',
): TaskOverviewItem {
  return { actionRight, source } as TaskOverviewItem;
}

test('counts needs_you and result_ready, ignoring discussions and other rights', () => {
  const counts = countWorkbenchInbox([
    item('needs_you'),
    item('needs_you'),
    item('result_ready'),
    item('peer_advancing'),
    item('needs_you', 'conversation'),
    item('result_ready', 'conversation'),
  ]);
  assert.deepEqual(counts, { needsYou: 2, resultReady: 1 });
});
