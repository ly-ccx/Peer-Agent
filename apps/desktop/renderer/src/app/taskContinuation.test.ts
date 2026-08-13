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
      openConversationDrawer: () => effects.push('conversation-drawer'),
      focusComposer: () => effects.push('focus'),
    });

    assert.deepEqual(effects, [
      'active',
      'conversation:conversation-1',
      'conversation-drawer',
      'focus',
    ]);
    assert.ok(!effects.includes('chat'), 'must not hard-switch main page to Chat');
    assert.ok(!effects.includes('close-result'), 'the parent result drawer must stay mounted beneath the child drawer');
  });
});

describe('getTaskContinuationAction', () => {
  it('keeps result_ready continuation as navigation without a plan mutation command', () => {
    assert.deepEqual(getTaskContinuationAction(item(), true), {
      conversationId: 'conversation-1',
      label: '还不行',
      description: '打开对应会话并聚焦输入框；在对话里说明哪里不对',
    });
  });

  it('uses the same navigation-only contract for non-result-ready cards', () => {
    const action = getTaskContinuationAction(
      item({ actionRight: 'peer_advancing', nextAction: 'none', actionLabel: '推进中', statusLabel: '推进中' }),
      true,
    );
    assert.deepEqual(action, {
      conversationId: 'conversation-1',
      label: '继续讨论',
      description: '打开原会话；发送消息后才会创建新的用户回合',
    });
  });

  it('explains that only a sent message starts a new user turn in English', () => {
    const action = getTaskContinuationAction(item(), false);
    assert.equal(action?.label, 'Not yet');
    assert.match(action?.description ?? '', /focus the input/i);
    assert.deepEqual(Object.keys(action ?? {}).sort(), ['conversationId', 'description', 'label']);
  });

  it('does not offer continuation for sources without a Conversation', () => {
    assert.equal(getTaskContinuationAction(item({ conversationId: undefined }), true), null);
    assert.equal(getTaskContinuationAction(item({ conversationId: '   ' }), true), null);
  });
});
