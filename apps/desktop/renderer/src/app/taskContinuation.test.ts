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
  it('opens a conversation drawer for the original Task without jumping main Chat', () => {
    const effects: string[] = [];
    continueTaskInConversation('conversation-1', {
      showActiveConversations: () => effects.push('active'),
      selectConversation: (id) => effects.push(`conversation:${id}`),
      closeResult: () => effects.push('close-result'),
      openConversationDrawer: () => effects.push('conversation-drawer'),
      focusComposer: () => effects.push('focus'),
    });

    assert.deepEqual(effects, [
      'active',
      'conversation:conversation-1',
      'close-result',
      'conversation-drawer',
      'focus',
    ]);
    assert.ok(!effects.includes('chat'), 'must not hard-switch main page to Chat');
    assert.ok(!effects.includes('close-collection'), 'collection close is owned by openConversationDrawer mutual exclusion');
  });
});

describe('getTaskContinuationAction', () => {
  it('marks result_ready goal plans as reopen-unaccepted (same card continuation)', () => {
    assert.deepEqual(getTaskContinuationAction(item(), true), {
      conversationId: 'conversation-1',
      planId: 'plan-1',
      reopenUnacceptedResult: true,
      label: '继续讨论',
      description: '验收未通过，回到原任务继续改（同一张卡）',
    });
  });

  it('does not reopen non-result_ready cards as acceptance failure', () => {
    const action = getTaskContinuationAction(
      item({ actionRight: 'peer_advancing', nextAction: 'none', actionLabel: '推进中', statusLabel: '推进中' }),
      true,
    );
    assert.equal(action?.reopenUnacceptedResult, false);
    assert.equal(action?.planId, undefined);
    assert.equal(action?.description, '打开原会话继续追问或发起下一步');
  });

  it('uses stable English copy for unaccepted result continuation', () => {
    const action = getTaskContinuationAction(item(), false);
    assert.equal(action?.label, 'Continue discussion');
    assert.match(action?.description ?? '', /same task|no new card/i);
    assert.equal(action?.reopenUnacceptedResult, true);
    assert.equal(action?.planId, 'plan-1');
  });

  it('does not offer continuation for sources without a Conversation', () => {
    assert.equal(getTaskContinuationAction(item({ conversationId: undefined }), true), null);
    assert.equal(getTaskContinuationAction(item({ conversationId: '   ' }), true), null);
  });
});
