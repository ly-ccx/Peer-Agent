import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ConversationStore,
  EMPTY_CONVERSATION_STATE,
} from './conversationStore.ts';
import type { ChatMsg } from './types.ts';

function msg(id: string, content: string): ChatMsg {
  return { id, role: 'assistant', content, timestamp: 0 };
}

describe('conversationStore', () => {
  it('returns the stable EMPTY singleton for unknown conversations', () => {
    const store = new ConversationStore();
    assert.equal(store.getSnapshot('nope'), EMPTY_CONVERSATION_STATE);
    assert.equal(store.getSnapshot(null), EMPTY_CONVERSATION_STATE);
    // 同一引用：useSyncExternalStore 据此判定「未变化」，不会进入死循环。
    assert.equal(store.getSnapshot('a'), store.getSnapshot('b'));
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

  it('beginLoad zeroes content and marks loading; commitLoad marks ready', () => {
    const store = new ConversationStore();
    store.setState('A', { messages: [msg('old', 'stale')], isStreaming: true });
    store.beginLoad('A');
    assert.equal(store.getSnapshot('A').loadStatus, 'loading');
    assert.equal(store.getSnapshot('A').messages.length, 0);
    assert.equal(store.getSnapshot('A').isStreaming, false);

    store.commitLoad('A', { messages: [msg('new', 'fresh')] });
    assert.equal(store.getSnapshot('A').loadStatus, 'ready');
    assert.equal(store.getSnapshot('A').messages[0].content, 'fresh');
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

  it('supports functional updater patches over previous snapshot', () => {
    const store = new ConversationStore();
    store.setState('A', { messages: [msg('m1', 'one')] });
    store.setState('A', (prev) => ({ messages: [...prev.messages, msg('m2', 'two')] }));
    assert.equal(store.getSnapshot('A').messages.length, 2);
    assert.equal(store.getSnapshot('A').messages[1].content, 'two');
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
