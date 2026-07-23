import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import {
  navigateToQuickChatConversation,
  runQuickChatSubmission,
  shouldRefreshQuickChatConversationList,
} from './quickChatSubmission.ts';

describe('shouldRefreshQuickChatConversationList', () => {
  it('refreshes only when the created conversation belongs to the active workspace', () => {
    assert.equal(shouldRefreshQuickChatConversationList('/workspace/a', '/workspace/a'), true);
    assert.equal(shouldRefreshQuickChatConversationList('/workspace/b', '/workspace/a'), false);
  });
});

describe('navigateToQuickChatConversation', () => {
  it('opens chat before switching workspace and selecting the conversation', async () => {
    const calls: string[] = [];

    await navigateToQuickChatConversation(
      { conversationId: 'conversation-1', workspacePath: '/workspace/a' },
      {
        openChatPage: () => { calls.push('open-chat'); },
        activateWorkspace: async (workspacePath) => { calls.push(`activate:${workspacePath}`); },
        refreshConversations: async (workspacePath) => { calls.push(`refresh:${workspacePath}`); },
        selectConversation: (conversationId) => { calls.push(`select:${conversationId}`); },
      },
    );

    assert.deepEqual(calls, [
      'open-chat',
      'activate:/workspace/a',
      'refresh:/workspace/a',
      'select:conversation-1',
    ]);
  });
});

describe('runQuickChatSubmission', () => {
  it('settles after a successful submission', async () => {
    const onError = mock.fn();
    const onSettled = mock.fn();

    await runQuickChatSubmission(async () => {}, onError, onSettled);

    assert.equal(onError.mock.callCount(), 0);
    assert.equal(onSettled.mock.callCount(), 1);
  });

  it('reports an error and still settles after a failed submission', async () => {
    const reason = new Error('submit failed');
    const onError = mock.fn();
    const onSettled = mock.fn();

    await runQuickChatSubmission(async () => { throw reason; }, onError, onSettled);

    assert.equal(onError.mock.callCount(), 1);
    assert.equal(onError.mock.calls[0]?.arguments[0], reason);
    assert.equal(onSettled.mock.callCount(), 1);
  });
});
