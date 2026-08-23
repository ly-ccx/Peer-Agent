import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskOverviewItem } from '@peer-agent/protocol';
import { groupInboxByConversation } from './inboxConversationGrouping.ts';

function item(partial: Partial<TaskOverviewItem> & Pick<TaskOverviewItem, 'taskId' | 'title' | 'actionRight'>): TaskOverviewItem {
  return {
    source: 'goal_plan',
    nextAction: 'open_conversation',
    statusLabel: 'ready',
    actionLabel: '打开',
    ...partial,
  } as TaskOverviewItem;
}

test('same conversationId collapses into one inbox card', () => {
  const cards = groupInboxByConversation([
    item({
      taskId: 'plan-a',
      conversationId: 'conv-1',
      title: '工作台改成行动收件箱',
      actionRight: 'result_ready',
      lastActiveAt: '2026-08-21T10:00:00.000Z',
    }),
    item({
      taskId: 'plan-b',
      conversationId: 'conv-1',
      title: '重做工作台',
      actionRight: 'result_ready',
      lastActiveAt: '2026-08-21T11:00:00.000Z',
    }),
    item({
      taskId: 'plan-c',
      conversationId: 'conv-2',
      title: '另一件事',
      actionRight: 'needs_you',
      lastActiveAt: '2026-08-21T09:00:00.000Z',
    }),
  ]);

  assert.equal(cards.length, 2);
  assert.equal(cards[0]?.conversationId, 'conv-2');
  assert.equal(cards[0]?.tone, 'needs_you');
  assert.equal(cards[1]?.conversationId, 'conv-1');
  assert.equal(cards[1]?.itemCount, 2);
  assert.equal(cards[1]?.latestItem.taskId, 'plan-b');
});

test('needs_you wins over result_ready on the same conversation', () => {
  const cards = groupInboxByConversation([
    item({
      taskId: 'ready',
      conversationId: 'conv-1',
      title: '待验收',
      actionRight: 'result_ready',
      lastActiveAt: '2026-08-21T12:00:00.000Z',
    }),
    item({
      taskId: 'need',
      conversationId: 'conv-1',
      title: '需要你处理',
      actionRight: 'needs_you',
      actionLabel: '去确认',
      lastActiveAt: '2026-08-21T11:00:00.000Z',
    }),
  ]);

  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.tone, 'needs_you');
  assert.equal(cards[0]?.actionLabel, '去确认');
  assert.equal(cards[0]?.latestItem.taskId, 'need');
  assert.equal(cards[0]?.itemCount, 2);
});

test('items without conversationId stay as their own cards', () => {
  const cards = groupInboxByConversation([
    item({
      taskId: 'solo-1',
      title: '无会话 A',
      actionRight: 'result_ready',
    }),
    item({
      taskId: 'solo-2',
      title: '无会话 B',
      actionRight: 'paused',
    }),
  ]);

  assert.equal(cards.length, 2);
  assert.equal(cards[0]?.tone, 'paused');
  assert.equal(cards[1]?.tone, 'result_ready');
});
