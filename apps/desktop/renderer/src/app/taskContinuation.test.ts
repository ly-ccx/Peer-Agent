import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TaskOverviewItem } from '@peer-agent/protocol';
import { continueTaskInConversation, getTaskContinuationAction } from './taskContinuation.ts';

function item(overrides: Partial<TaskOverviewItem> = {}): TaskOverviewItem {
  return {
    taskId: 'plan-1',
    source: 'goal_plan',
    conversationId: 'conversation-1',
    workspaceLabel: 'workspace',
    title: 'Design task continuation',
    actionRight: 'result_ready',
    nextAction: 'review_result',
    actionLabel: '查看结果',
    statusLabel: '等待验收',
    lastActiveAt: '2026-08-08T00:00:00.000Z',
    ...overrides,
  };
}

describe('continueTaskInConversation', () => {
  it('restores the original Task scene without sending a message or creating a Goal', () => {
    const effects: string[] = [];
    continueTaskInConversation('conversation-1', {
      showActiveConversations: () => effects.push('active'),
      selectConversation: (id) => effects.push(`conversation:${id}`),
      closeResult: () => effects.push('close-result'),
      closeCollection: () => effects.push('close-collection'),
      showChat: () => effects.push('chat'),
      focusComposer: () => effects.push('focus'),
    });

    assert.deepEqual(effects, [
      'active',
      'conversation:conversation-1',
      'close-result',
      'close-collection',
      'chat',
      'focus',
    ]);
  });
});

describe('getTaskContinuationAction', () => {
  it('returns the original Conversation identity without creating an execution action', () => {
    assert.deepEqual(getTaskContinuationAction(item(), true), {
      conversationId: 'conversation-1',
      label: '继续任务',
      description: '回到原任务，继续追问或发起下一步',
    });
  });

  it('uses stable English copy', () => {
    const action = getTaskContinuationAction(item(), false);
    assert.equal(action?.label, 'Continue task');
    assert.match(action?.description ?? '', /original task/);
  });

  it('does not offer continuation for sources without a Conversation', () => {
    assert.equal(getTaskContinuationAction(item({ conversationId: undefined }), true), null);
    assert.equal(getTaskContinuationAction(item({ conversationId: '   ' }), true), null);
  });
});
