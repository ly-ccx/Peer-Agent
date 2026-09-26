import assert from 'node:assert/strict';
import test from 'node:test';
import { createBroadcastSink, createCallbackSink, createCollectingSink } from './turn-sinks.mjs';

test('collecting sink accumulates delta text and ignores non-string deltas', () => {
  const sink = createCollectingSink();
  sink.send('chat:stream:delta', { content: 'hello' });
  sink.send('chat:stream:delta', { content: ' ' });
  sink.send('chat:stream:delta', { content: 1 });
  sink.send('chat:stream:thinking', { content: 'hidden' });
  assert.equal(sink.getText(), 'hello ');
});

test('collecting sink records each terminal state and keeps the latest', () => {
  for (const channel of ['chat:stream:done', 'chat:stream:error', 'chat:stream:aborted']) {
    const sink = createCollectingSink();
    sink.send(channel, { error: channel });
    assert.deepEqual(sink.getTerminal(), { channel, payload: { error: channel } });
  }
  const sink = createCollectingSink();
  sink.send('chat:stream:done', { ok: true });
  sink.send('chat:stream:error', { error: 'later' });
  assert.equal(sink.getTerminal().channel, 'chat:stream:error');
});

test('collecting sink getEvents returns a copy', () => {
  const sink = createCollectingSink();
  sink.send('chat:stream:delta', { content: 'a' });
  const events = sink.getEvents();
  events.push({ channel: 'extra', payload: null });
  assert.notEqual(events, sink.getEvents());
  assert.deepEqual(sink.getEvents(), [{ channel: 'chat:stream:delta', payload: { content: 'a' } }]);
});

test('collecting sink has no isDestroyed of its own', () => {
  const sink = createCollectingSink();
  assert.equal(typeof sink.isDestroyed, 'undefined');
});

test('callback sink forwards events and is never destroyed', () => {
  const seen = [];
  const sink = createCallbackSink((event) => seen.push(event));
  sink.send('chat:stream:delta', { content: 'x' });
  assert.deepEqual(seen, [{ channel: 'chat:stream:delta', payload: { content: 'x' } }]);
  assert.equal(sink.isDestroyed(), false);
});

function fakeWindow(sent, { destroyed = false } = {}) {
  return {
    isDestroyed: () => destroyed,
    webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
  };
}

test('broadcast sink delivers to every live window and drops when none exist', () => {
  const empty = createBroadcastSink({ getWindows: () => [] });
  assert.doesNotThrow(() => empty.send('chat:stream:delta', { content: 'x' }));
  assert.equal(empty.isDestroyed(), false);

  const first = [];
  const second = [];
  const sink = createBroadcastSink({
    getWindows: () => [fakeWindow(first), fakeWindow(second, { destroyed: true }), null],
  });
  sink.send('chat:stream:delta', { content: 'hi' });
  assert.deepEqual(first, [{ channel: 'chat:stream:delta', payload: { content: 'hi' } }]);
  assert.deepEqual(second, []);
});

test('callback sink tolerates a missing listener', () => {
  const sink = createCallbackSink();
  assert.doesNotThrow(() => sink.send('chat:stream:done', {}));
  assert.equal(sink.isDestroyed(), false);
});
