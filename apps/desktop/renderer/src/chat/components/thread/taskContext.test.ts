import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskOverviewItem } from '@peer-agent/protocol';
import { projectChatTaskContext } from './taskContext.ts';

const discussion: TaskOverviewItem = {
  taskId: 'conversation-1',
  source: 'conversation',
  actionRight: 'paused',
  nextAction: 'continue_task',
  title: '讨论 Task 与 Plan 的关系',
  statusLabel: '讨论中',
  actionLabel: '继续讨论 →',
  conversationId: 'conversation-1',
};

test('discussion context stays plan-free and links to task details', () => {
  assert.deepEqual(projectChatTaskContext(discussion, true), {
    statusLabel: '讨论中',
    detailLabel: '任务详情',
  });
});

test('execution context exposes current Goal title without replacing Task title', () => {
  assert.deepEqual(projectChatTaskContext({
    ...discussion,
    source: 'goal_plan',
    taskId: 'plan-1',
    actionRight: 'peer_advancing',
    statusLabel: '执行中',
    currentGoalTitle: '实现 Task 上下文界面',
  }, false), {
    statusLabel: '执行中',
    currentGoalTitle: '实现 Task 上下文界面',
    detailLabel: 'Task details',
  });
});

test('non-conversation sources do not appear in chat task context', () => {
  assert.equal(projectChatTaskContext({ ...discussion, conversationId: undefined }, true), null);
});
