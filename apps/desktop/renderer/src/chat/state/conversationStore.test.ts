import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  areConversationStatesEqualForSurface,
  ConversationStore,
  createConversationSurfaceSnapshotReader,
  DRAFT_CONVERSATION_ID,
  EMPTY_CONVERSATION_STATE,
  resolveConversationBucketId,
} from './conversationStore.ts';
import type { ChatMsg, QueuedMessage } from './types.ts';

function msg(id: string, content: string): ChatMsg {
  return { id, role: 'assistant', content, timestamp: 0 };
}

function queued(id: string, text: string): QueuedMessage {
  return { id, text, attachments: [], effort: 'default' };
}

describe('conversationStore', () => {
  it('returns the stable EMPTY singleton for unknown conversations', () => {
    const store = new ConversationStore();
    assert.equal(store.getSnapshot('nope'), EMPTY_CONVERSATION_STATE);
    // null 映射到草稿桶；未写入前同样返回 EMPTY 单例。
    assert.equal(store.getSnapshot(null), EMPTY_CONVERSATION_STATE);
    // 同一引用：useSyncExternalStore 据此判定「未变化」，不会进入死循环。
    assert.equal(store.getSnapshot('a'), store.getSnapshot('b'));
  });

  it('maps null conversationId to a writable draft bucket', () => {
    const store = new ConversationStore();
    assert.equal(resolveConversationBucketId(null), DRAFT_CONVERSATION_ID);
    assert.equal(resolveConversationBucketId(''), DRAFT_CONVERSATION_ID);
    assert.equal(resolveConversationBucketId('real-id'), 'real-id');

    store.setDraft(null, 'hello draft');
    store.commitLoad(null, { messages: [] });

    assert.equal(store.getSnapshot(null).draft, 'hello draft');
    assert.equal(store.getSnapshot(null).loadStatus, 'ready');
    // 草稿桶与真实会话桶隔离。
    assert.equal(store.getSnapshot('real-id').draft, '');
    assert.equal(store.getSnapshot(DRAFT_CONVERSATION_ID).draft, 'hello draft');

    let notified = 0;
    store.subscribe(null, () => {
      notified += 1;
    });
    store.setDraft(null, 'updated');
    assert.equal(notified, 1);
    assert.equal(store.getSnapshot(null).draft, 'updated');
  });

  it('keeps composer selections when a sidebar subscriber closes and reopens', () => {
    const store = new ConversationStore();
    const conversationId = 'sidebar-conversation';
    let notifications = 0;

    const unsubscribe = store.subscribe(conversationId, () => {
      notifications += 1;
    });
    store.setState(conversationId, {
      modelProviderId: 'openai-subscription',
      effort: 'high',
      fastMode: true,
    });
    assert.equal(notifications, 1);
    unsubscribe();

    // 关闭侧栏只移除订阅者，不应清空会话桶。重新挂载时读回同一份选择。
    assert.equal(store.hasBucket(conversationId), true);
    const reopened = store.getSnapshot(conversationId);
    assert.equal(reopened.modelProviderId, 'openai-subscription');
    assert.equal(reopened.effort, 'high');
    assert.equal(reopened.fastMode, true);

    let reopenedNotifications = 0;
    const unsubscribeReopened = store.subscribe(conversationId, () => {
      reopenedNotifications += 1;
    });
    store.setState(conversationId, { fastMode: false });
    assert.equal(reopenedNotifications, 1);
    assert.equal(store.getSnapshot(conversationId).modelProviderId, 'openai-subscription');
    assert.equal(store.getSnapshot(conversationId).effort, 'high');
    unsubscribeReopened();
  });

  it('keeps draft composer selections when the sidebar remounts before first send', () => {
    const store = new ConversationStore();
    store.setState(null, {
      modelProviderId: 'openai-subscription',
      effort: 'medium',
      fastMode: true,
    });

    assert.equal(store.hasBucket(null), true);
    const reopenedDraft = store.getSnapshot(null);
    assert.equal(reopenedDraft.modelProviderId, 'openai-subscription');
    assert.equal(reopenedDraft.effort, 'medium');
    assert.equal(reopenedDraft.fastMode, true);
  });

  it('isolates state between conversation buckets', () => {
    const store = new ConversationStore();
    store.setState('A', { messages: [msg('m1', 'hi from A')], isStreaming: true });
    store.setState('B', { messages: [msg('m2', 'hi from B')] });

    assert.equal(store.getSnapshot('A').messages.length, 1);
    assert.equal(store.getSnapshot('A').messages[0].content, 'hi from A');
    assert.equal(store.getSnapshot('A').isStreaming, true);
    // B 完全不受 A 影响——这就是「物理上不存在共享 messages 槽位」的核心保证。
    assert.equal(store.getSnapshot('B').messages[0].content, 'hi from B');
    assert.equal(store.getSnapshot('B').isStreaming, false);
  });

  it('produces a new immutable snapshot reference on change', () => {
    const store = new ConversationStore();
    store.setState('A', { isStreaming: true });
    const first = store.getSnapshot('A');
    store.setState('A', { isStreaming: false });
    const second = store.getSnapshot('A');
    assert.notEqual(first, second);
    assert.equal(first.isStreaming, true);
    assert.equal(second.isStreaming, false);
  });

  it('does not notify or change reference when patch is a no-op', () => {
    const store = new ConversationStore();
    store.setState('A', { isStreaming: true });
    const before = store.getSnapshot('A');
    let notified = 0;
    store.subscribe('A', () => {
      notified += 1;
    });
    store.setState('A', { isStreaming: true }); // 同值
    assert.equal(notified, 0);
    assert.equal(store.getSnapshot('A'), before);
  });

  it('only notifies subscribers of the changed bucket', () => {
    const store = new ConversationStore();
    let aCount = 0;
    let bCount = 0;
    store.subscribe('A', () => {
      aCount += 1;
    });
    store.subscribe('B', () => {
      bCount += 1;
    });
    store.setState('A', { isStreaming: true });
    assert.equal(aCount, 1);
    assert.equal(bCount, 0);
  });

  it('stops notifying after unsubscribe', () => {
    const store = new ConversationStore();
    let count = 0;
    const off = store.subscribe('A', () => {
      count += 1;
    });
    store.setState('A', { isStreaming: true });
    off();
    store.setState('A', { isStreaming: false });
    assert.equal(count, 1);
  });

  it('beginLoad zeroes content and marks loading; commitLoad marks ready without dropping composer state', () => {
    const store = new ConversationStore();
    store.setState('A', {
      messages: [msg('old', 'stale')],
      isStreaming: true,
      draft: 'draft A',
      messageQueue: [queued('q-a', 'queued A')],
    });
    store.beginLoad('A');
    assert.equal(store.getSnapshot('A').loadStatus, 'loading');
    assert.equal(store.getSnapshot('A').messages.length, 0);
    assert.equal(store.getSnapshot('A').isStreaming, false);
    assert.equal(store.getSnapshot('A').draft, 'draft A');
    assert.equal(store.getSnapshot('A').messageQueue[0]?.text, 'queued A');

    store.commitLoad('A', { messages: [msg('new', 'fresh')] });
    assert.equal(store.getSnapshot('A').loadStatus, 'ready');
    assert.equal(store.getSnapshot('A').messages[0].content, 'fresh');
  });

  it('keeps streamError on the interrupted conversation when another conversation loads', () => {
    const store = new ConversationStore();
    store.setState('A', { streamError: 'net::ERR_NETWORK_CHANGED' });
    store.setState('B', { streamError: null });
    store.beginLoad('B');
    assert.equal(store.getSnapshot('A').streamError, 'net::ERR_NETWORK_CHANGED');
    assert.equal(store.getSnapshot('B').streamError, null);

    const interrupted = { ...msg('a1', 'partial'), role: 'assistant' as const, interrupted: true };
    store.beginLoad('A');
    assert.equal(store.getSnapshot('A').streamError, null);
    store.commitLoad('A', {
      messages: [interrupted],
      streamError: 'net::ERR_NETWORK_CHANGED',
    });
    assert.equal(store.getSnapshot('A').streamError, 'net::ERR_NETWORK_CHANGED');
    assert.equal(store.getSnapshot('B').streamError, null);
  });

  it('keeps draft and queued user messages isolated per conversation', () => {
    const store = new ConversationStore();
    store.setDraft('A', 'draft A');
    store.enqueueMessage('A', queued('q-a1', 'queued A 1'));
    store.enqueueMessage('A', queued('q-a2', 'queued A 2'));
    store.setDraft('B', 'draft B');
    store.enqueueMessage('B', queued('q-b1', 'queued B 1'));

    assert.equal(store.getSnapshot('A').draft, 'draft A');
    assert.deepEqual(store.getSnapshot('A').messageQueue.map((item) => item.text), ['queued A 1', 'queued A 2']);
    assert.equal(store.getSnapshot('B').draft, 'draft B');
    assert.deepEqual(store.getSnapshot('B').messageQueue.map((item) => item.text), ['queued B 1']);

    const fromB = store.shiftQueuedMessage('B');
    assert.equal(fromB?.text, 'queued B 1');
    assert.equal(store.getSnapshot('B').messageQueue.length, 0);
    assert.deepEqual(store.getSnapshot('A').messageQueue.map((item) => item.text), ['queued A 1', 'queued A 2']);

    store.removeQueuedMessage('A', 'q-a1');
    assert.deepEqual(store.getSnapshot('A').messageQueue.map((item) => item.text), ['queued A 2']);
    assert.equal(store.getSnapshot('B').messageQueue.length, 0);
  });

  it('updates queued message text and reorders queue items', () => {
    const store = new ConversationStore();
    store.enqueueMessage('A', queued('q1', 'first'));
    store.enqueueMessage('A', queued('q2', 'second'));
    store.enqueueMessage('A', queued('q3', 'third'));

    store.updateQueuedMessage('A', 'q2', 'second-edited');
    assert.deepEqual(
      store.getSnapshot('A').messageQueue.map((item) => item.text),
      ['first', 'second-edited', 'third'],
    );

    // 未知 id / 相同文案不改队列。
    store.updateQueuedMessage('A', 'missing', 'noop');
    store.updateQueuedMessage('A', 'q2', 'second-edited');
    assert.deepEqual(
      store.getSnapshot('A').messageQueue.map((item) => item.text),
      ['first', 'second-edited', 'third'],
    );

    store.reorderQueuedMessage('A', 0, 2);
    assert.deepEqual(
      store.getSnapshot('A').messageQueue.map((item) => item.id),
      ['q2', 'q3', 'q1'],
    );

    store.reorderQueuedMessage('A', 2, 0);
    assert.deepEqual(
      store.getSnapshot('A').messageQueue.map((item) => item.id),
      ['q1', 'q2', 'q3'],
    );

    // 越界索引忽略。
    store.reorderQueuedMessage('A', -1, 1);
    store.reorderQueuedMessage('A', 0, 99);
    assert.deepEqual(
      store.getSnapshot('A').messageQueue.map((item) => item.id),
      ['q1', 'q2', 'q3'],
    );
  });

  it('promotes a queued message to the front without reshuffling the rest', () => {
    const store = new ConversationStore();
    store.enqueueMessage('A', queued('q1', 'first'));
    store.enqueueMessage('A', queued('q2', 'second'));
    store.enqueueMessage('A', queued('q3', 'third'));

    store.promoteQueuedMessageToFront('A', 'q3');
    assert.deepEqual(
      store.getSnapshot('A').messageQueue.map((item) => item.id),
      ['q3', 'q1', 'q2'],
    );

    // 已在队首 / 未知 id 为 no-op。
    store.promoteQueuedMessageToFront('A', 'q3');
    store.promoteQueuedMessageToFront('A', 'missing');
    assert.deepEqual(
      store.getSnapshot('A').messageQueue.map((item) => item.id),
      ['q3', 'q1', 'q2'],
    );

    // 中间项插队后，其余相对顺序不变。
    store.promoteQueuedMessageToFront('A', 'q2');
    assert.deepEqual(
      store.getSnapshot('A').messageQueue.map((item) => item.id),
      ['q2', 'q3', 'q1'],
    );
  });

  it('routes streamId to its owning conversation and clears on finalize', () => {
    const store = new ConversationStore();
    store.routeStream('s-1', 'A');
    store.routeStream('s-2', 'B');
    assert.equal(store.resolveConversation('s-1'), 'A');
    assert.equal(store.resolveConversation('s-2'), 'B');
    assert.equal(store.resolveConversation('unknown'), null);

    store.clearStream('s-1');
    assert.equal(store.resolveConversation('s-1'), null);
    // 其它路由不受影响。
    assert.equal(store.resolveConversation('s-2'), 'B');
  });

  it('settles only renderer streams missing from the authoritative active snapshot', () => {
    const store = new ConversationStore();
    store.routeStream('stream-stale', 'A');
    store.routeStream('stream-active', 'B');
    store.setState('A', {
      isStreaming: true,
      streamId: 'stream-stale',
      activeUsage: { input: 1, output: 2, cacheWrite: 0, cacheRead: 0 },
      toolProgress: { tool: 'bash', path: null, receivedLines: 1 },
      turnStartedAt: 10,
    });
    store.setState('B', { isStreaming: true, streamId: 'stream-active' });

    assert.deepEqual(store.settleInactiveStreams(['stream-active']), ['A']);
    assert.deepEqual(
      {
        isStreaming: store.getSnapshot('A').isStreaming,
        streamId: store.getSnapshot('A').streamId,
        activeUsage: store.getSnapshot('A').activeUsage,
        pendingPermissionCalls: store.getSnapshot('A').pendingPermissionCalls,
        toolProgress: store.getSnapshot('A').toolProgress,
        turnStartedAt: store.getSnapshot('A').turnStartedAt,
      },
      {
        isStreaming: false,
        streamId: null,
        activeUsage: null,
        pendingPermissionCalls: [],
        toolProgress: null,
        turnStartedAt: null,
      },
    );
    assert.equal(store.resolveConversation('stream-stale'), null);
    assert.equal(store.getSnapshot('B').isStreaming, true);
    assert.equal(store.getSnapshot('B').streamId, 'stream-active');
    assert.equal(store.resolveConversation('stream-active'), 'B');
  });

  it('routes an explicitly identified compaction event to A while a new B stays idle', () => {
    const store = new ConversationStore();
    store.routeStream('stream-A', 'A');
    store.setState('A', {
      compactionState: { phase: 'running', percent: 0, streamId: 'stream-A', startedAt: 1 },
    });

    const eventConversationId = store.resolveEventConversation('stream-A', 'A');
    assert.equal(eventConversationId, 'A');
    store.setState(eventConversationId!, {
      compactionState: { phase: 'running', percent: 42, streamId: 'stream-A', startedAt: 1 },
    });

    assert.deepEqual(store.getSnapshot('B').compactionState, { phase: 'idle' });
    assert.deepEqual(store.getSnapshot('A').compactionState, {
      phase: 'running',
      percent: 42,
      streamId: 'stream-A',
      startedAt: 1,
    });
  });

  it('uses explicit event identity to repair a missing local stream route', () => {
    const store = new ConversationStore();
    assert.equal(store.resolveConversation('stream-A'), null);
    assert.equal(store.resolveEventConversation('stream-A', 'A'), 'A');
    assert.equal(store.resolveConversation('stream-A'), 'A');
  });

  it('routes a background recovery notice by authoritative event identity', () => {
    const store = new ConversationStore();
    store.routeStream('stream-background', 'foreground');

    const conversationId = store.resolveEventConversation('stream-background', 'background');
    assert.equal(conversationId, 'background');
    store.setState(conversationId, {
      providerRecoveryNotice: {
        kind: 'connection',
        status: 'retrying',
        provider: 'Background provider',
      },
    });

    assert.equal(store.getSnapshot('foreground').providerRecoveryNotice, null);
    assert.deepEqual(store.getSnapshot('background').providerRecoveryNotice, {
      kind: 'connection',
      status: 'retrying',
      provider: 'Background provider',
    });
    assert.equal(store.resolveConversation('stream-background'), 'background');
  });

  it('supports functional updater patches over previous snapshot', () => {
    const store = new ConversationStore();
    store.setState('A', { messages: [msg('m1', 'one')] });
    store.setState('A', (prev) => ({ messages: [...prev.messages, msg('m2', 'two')] }));
    assert.equal(store.getSnapshot('A').messages.length, 2);
    assert.equal(store.getSnapshot('A').messages[1].content, 'two');
  });

  it('selector subscriptions ignore hot message updates outside their selected field', () => {
    const store = new ConversationStore();
    let compactionNotifications = 0;
    let permissionNotifications = 0;
    store.subscribeSelector('A', (state) => state.compactionState, () => {
      compactionNotifications += 1;
    });
    store.subscribeSelector('A', (state) => state.pendingPermissionCalls.length, () => {
      permissionNotifications += 1;
    });

    for (let index = 0; index < 100; index += 1) {
      store.setState('A', { messages: [msg('stream', `token-${index}`)] });
    }

    assert.equal(compactionNotifications, 0);
    assert.equal(permissionNotifications, 0);

    store.setState('A', {
      compactionState: { phase: 'running', percent: 1, streamId: 'stream-A', startedAt: 1 },
    });
    store.setState('A', {
      pendingPermissionCalls: [{
        toolCallId: 'permission-1',
        capabilityId: 'local.bash',
        displayName: 'Bash',
        reason: 'confirm',
        argumentsPreview: {},
        riskLevel: 'L0_inert',
        dataLevel: 'D0_public',
        requestedAt: '2026-07-16T00:00:00.000Z',
      }],
    });

    assert.equal(compactionNotifications, 1);
    assert.equal(permissionNotifications, 1);
  });

  it('surface equality ignores draft and tool progress but keeps all other state changes visible', () => {
    const base = { ...EMPTY_CONVERSATION_STATE, isStreaming: true };
    const withProgressAndDraft = {
      ...base,
      draft: 'local composer text',
      toolProgress: { tool: 'edit_file', path: 'src/a.ts', receivedLines: 40 },
    };
    assert.equal(areConversationStatesEqualForSurface(base, withProgressAndDraft), true);
    assert.equal(
      areConversationStatesEqualForSurface(withProgressAndDraft, { ...withProgressAndDraft, isStreaming: false }),
      false,
    );
    assert.equal(
      areConversationStatesEqualForSurface(withProgressAndDraft, {
        ...withProgressAndDraft,
        messages: [msg('m1', 'updated')],
      }),
      false,
    );
  });

  it('keeps rapid tool progress writes out of the surface subscription', () => {
    const store = new ConversationStore();
    let surfaceNotifications = 0;
    store.subscribeSelector(
      'A',
      (state) => state,
      () => {
        surfaceNotifications += 1;
      },
      areConversationStatesEqualForSurface,
    );

    for (let line = 1; line <= 100; line += 1) {
      store.setState('A', {
        toolProgress: { tool: 'edit_file', path: 'src/a.ts', receivedLines: line },
      });
    }
    assert.equal(surfaceNotifications, 0);

    store.setState('A', { messages: [msg('stream', 'visible update')] });
    assert.equal(surfaceNotifications, 1);
  });

  it('keeps rapid draft writes in the composer leaf subscription', () => {
    const store = new ConversationStore();
    let surfaceNotifications = 0;
    let draftNotifications = 0;
    store.subscribeSelector(
      'A',
      (state) => state,
      () => {
        surfaceNotifications += 1;
      },
      areConversationStatesEqualForSurface,
    );
    store.subscribeSelector('A', (state) => state.draft, () => {
      draftNotifications += 1;
    });

    for (let length = 1; length <= 100; length += 1) {
      store.setDraft('A', 'x'.repeat(length));
    }
    assert.equal(surfaceNotifications, 0);
    assert.equal(draftNotifications, 100);
    assert.equal(store.getSnapshot('A').draft.length, 100);

    store.setState('A', { messages: [msg('stream', 'visible update')] });
    assert.equal(surfaceNotifications, 1);
  });

  it('keeps the surface snapshot reference stable across draft and progress-only writes', () => {
    const store = new ConversationStore();
    store.setState('A', { isStreaming: true });
    const readSurfaceSnapshot = createConversationSurfaceSnapshotReader(
      () => store.getSnapshot('A'),
    );
    const initial = readSurfaceSnapshot();

    store.setDraft('A', 'latest local draft');
    store.setState('A', {
      toolProgress: { tool: 'write_file', path: 'src/a.ts', receivedLines: 80 },
    });
    assert.equal(readSurfaceSnapshot(), initial);

    store.setState('A', { messages: [msg('stream', 'visible update')] });
    const updated = readSurfaceSnapshot();
    assert.notEqual(updated, initial);
    assert.equal(updated.draft, 'latest local draft');
    assert.equal(updated.toolProgress?.receivedLines, 80);
  });

  it('reset drops the bucket and notifies', () => {
    const store = new ConversationStore();
    store.setState('A', { isStreaming: true });
    let notified = 0;
    store.subscribe('A', () => {
      notified += 1;
    });
    store.reset('A');
    assert.equal(store.getSnapshot('A'), EMPTY_CONVERSATION_STATE);
    assert.equal(notified, 1);
  });
});
