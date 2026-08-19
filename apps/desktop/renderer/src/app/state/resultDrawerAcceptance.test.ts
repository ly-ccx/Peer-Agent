import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskOverviewItem } from '@peer-agent/protocol';
import {
  collectPendingAcceptanceItems,
  resolveResultDrawerAcceptanceTargets,
} from './resultDrawerAcceptance.ts';

function item(
  taskId: string,
  actionRight: TaskOverviewItem['actionRight'] = 'result_ready',
): TaskOverviewItem {
  return {
    taskId,
    source: 'goal_plan',
    actionRight,
    nextAction: actionRight === 'result_ready' ? 'review_result' : 'continue_task',
    title: taskId,
    statusLabel: actionRight === 'result_ready' ? '等待验收' : '进行中',
    actionLabel: '查看结果',
    lastActiveAt: '1970-01-01T00:00:00.000Z',
  };
}

test('collectPendingAcceptanceItems 只收待签项并去重', () => {
  const pending = collectPendingAcceptanceItems([
    item('a'),
    item('b', 'peer_advancing'),
    item('a'),
    item('c'),
  ]);
  assert.deepEqual(pending.map((entry) => entry.taskId), ['a', 'c']);
});

test('归组卡查看结果后确认验收，签完这条线上全部待签项', () => {
  const latest = item('r2');
  const together = [item('r1'), item('r2')];
  const targets = resolveResultDrawerAcceptanceTargets(latest, together);
  assert.deepEqual(targets.map((entry) => entry.taskId), ['r1', 'r2']);
});

test('单张结果卡或点某一行打开时，只验收这一项', () => {
  const current = item('r1');
  const targets = resolveResultDrawerAcceptanceTargets(current);
  assert.deepEqual(targets.map((entry) => entry.taskId), ['r1']);
});

test('点某一行即使同线还有其他待签，也不顺带签掉', () => {
  const current = item('r1');
  const ignoredSiblings = [item('r1'), item('r2')];
  const targets = resolveResultDrawerAcceptanceTargets(current, null);
  assert.deepEqual(targets.map((entry) => entry.taskId), ['r1']);
  assert.notDeepEqual(
    resolveResultDrawerAcceptanceTargets(current, ignoredSiblings).map((entry) => entry.taskId),
    ['r1'],
  );
});
