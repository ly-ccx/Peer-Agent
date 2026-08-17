import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GoalPlan, TaskOverviewItem } from '@peer-agent/protocol';
import { findTaskRelatedMessageId } from './taskRelatedMessage.ts';
import type { ChatMsg } from './types.ts';

function item(overrides: Partial<TaskOverviewItem> = {}): TaskOverviewItem {
  return {
    taskId: 'plan-round-3',
    source: 'goal_plan',
    actionRight: 'result_ready',
    nextAction: 'review_result',
    title: '截图验收产物卡 Frost 改版',
    statusLabel: '等待验收',
    conversationId: 'conv-1',
    ...overrides,
  } as TaskOverviewItem;
}

function msg(id: string, content: string, role: ChatMsg['role'] = 'assistant'): ChatMsg {
  return { id, role, content };
}

describe('findTaskRelatedMessageId', () => {
  it('prefers the last message that contains this round planId over a later title-only match', () => {
    const messages = [
      msg('m1', '开始第 1 轮 plan-round-1'),
      msg('m2', '开始第 3 轮 plan-round-3'),
      msg('m3', '截图验收产物卡 Frost 改版 的后续讨论'),
    ];
    assert.equal(findTaskRelatedMessageId(messages, item(), null), 'm2');
  });

  it('falls back to the last user title match when no planId is present', () => {
    const messages = [
      msg('m1', '无关消息'),
      msg('m2', '请做：截图验收产物卡 Frost 改版', 'user'),
      msg('m3', '已完成最新一轮'),
    ];
    assert.equal(findTaskRelatedMessageId(messages, item(), null), 'm2');
  });

  it('uses plan.planId even when item.taskId is absent from the transcript', () => {
    const messages = [
      msg('m1', '开始 plan-from-detail'),
      msg('m2', '最新一轮其它计划'),
    ];
    const plan = { planId: 'plan-from-detail', title: '其它标题', goal: '' } as GoalPlan;
    assert.equal(findTaskRelatedMessageId(messages, item({ taskId: 'unseen-plan' }), plan), 'm1');
  });

  it('falls back to the last message when nothing matches', () => {
    const messages = [msg('m1', 'hello'), msg('m2', 'world')];
    assert.equal(
      findTaskRelatedMessageId(messages, item({ taskId: 'x', title: '没有这段话' }), null),
      'm2',
    );
  });
});
