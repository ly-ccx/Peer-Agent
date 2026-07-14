import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createDesktopRuntimeSessionAdapter } from './runtime-session-adapter.mjs';

describe('Desktop Runtime session adapter', () => {
  it('starts and resumes one conversation session across streams', () => {
    const adapter = createDesktopRuntimeSessionAdapter();

    const first = adapter.startStream({ streamId: 'stream-1', conversationId: 'conversation-1' });
    assert.equal(first.sessionId, 'conversation-1');
    assert.equal(first.turnIndex, 0);
    adapter.settleStream('stream-1', 'done');

    const second = adapter.startStream({ streamId: 'stream-2', conversationId: 'conversation-1' });
    assert.equal(second.sessionId, 'conversation-1');
    assert.equal(second.turnIndex, 1);
    assert.equal(second.turnId, 'conversation-1:turn:1');
    assert.equal(adapter.getSession('conversation-1').activeTurn.streamId, 'stream-2');
  });

  it('uses the stream as the session identity when no conversation exists', () => {
    const adapter = createDesktopRuntimeSessionAdapter();
    const turn = adapter.startStream({ streamId: 'ephemeral-stream' });

    assert.equal(turn.sessionId, 'ephemeral-stream');
    assert.equal(turn.conversationId, undefined);
    adapter.settleStream('ephemeral-stream', 'done');
    assert.equal(adapter.getSession('ephemeral-stream'), null);
  });

  it('maps Desktop abort to SDK cancellation and aborts provider work', () => {
    const adapter = createDesktopRuntimeSessionAdapter();
    const turn = adapter.startStream({ streamId: 'stream-1', conversationId: 'conversation-1' });

    const snapshot = adapter.cancelStream('stream-1', 'user_aborted');

    assert.equal(turn.signal.aborted, true);
    assert.equal(snapshot.status, 'idle');
    assert.equal(snapshot.lastTurn.status, 'cancelled');
    assert.equal(snapshot.lastTurn.reason, 'user_aborted');
    assert.equal(adapter.getActiveTurn('stream-1'), null);
  });

  it('maps Desktop errors to failed SDK turns without changing the session identity', () => {
    const adapter = createDesktopRuntimeSessionAdapter();
    const turn = adapter.startStream({ streamId: 'stream-1', conversationId: 42 });

    const snapshot = adapter.failStream('stream-1', 'provider_error');

    assert.equal(turn.sessionId, '42');
    assert.equal(turn.signal.aborted, true);
    assert.equal(snapshot.lastTurn.status, 'failed');
    assert.equal(snapshot.lastTurn.reason, 'provider_error');
  });

  it('does not let a late Desktop completion replace an aborted terminal state', () => {
    const adapter = createDesktopRuntimeSessionAdapter();
    adapter.startStream({ streamId: 'stream-1', conversationId: 'conversation-1' });
    const cancelled = adapter.cancelStream('stream-1');

    assert.equal(adapter.settleStream('stream-1', 'done'), null);
    assert.equal(cancelled.lastTurn.status, 'cancelled');
    assert.equal(adapter.getSession('conversation-1').lastTurn.status, 'cancelled');
  });
});
