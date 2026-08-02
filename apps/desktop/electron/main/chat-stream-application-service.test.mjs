import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatStreamApplicationService } from './chat-stream-application-service.mjs';

function createHarness(overrides = {}) {
  const calls = [];
  const service = createChatStreamApplicationService({
    abortStream: (streamId) => {
      calls.push(['abort', streamId]);
      return { aborted: streamId };
    },
    reattachStream: (input) => {
      calls.push(['reattach', input]);
      return { streamId: input.streamId };
    },
    listActiveConversationIds: () => {
      calls.push(['list-conversations']);
      return ['conversation-1'];
    },
    listActiveStreams: () => {
      calls.push(['list-streams']);
      return [{ streamId: 'stream-1', conversationId: 'conversation-1' }];
    },
    ...overrides,
  });
  return { service, calls };
}

test('chat stream service preserves abort and reattach projection', () => {
  const { service, calls } = createHarness();

  assert.deepEqual(service.abort({ streamId: 'stream-1' }), { aborted: 'stream-1' });
  assert.deepEqual(
    service.reattach({ streamId: 'stream-1', conversationId: 'conversation-1' }),
    { streamId: 'stream-1' },
  );
  assert.deepEqual(calls, [
    ['abort', 'stream-1'],
    ['reattach', { streamId: 'stream-1', conversationId: 'conversation-1' }],
  ]);
});

test('chat stream service keeps the ADR 27 list-active compatibility shape', () => {
  const { service, calls } = createHarness();

  assert.deepEqual(service.listActive(), {
    conversationIds: ['conversation-1'],
    streams: [{ streamId: 'stream-1', conversationId: 'conversation-1' }],
  });
  assert.deepEqual(calls, [['list-conversations'], ['list-streams']]);
});

test('chat stream service preserves default empty reattach input', () => {
  const { service, calls } = createHarness();
  service.reattach();
  assert.deepEqual(calls, [['reattach', {}]]);
});

test('chat stream service fails fast when a port is absent', () => {
  assert.throws(() => createChatStreamApplicationService(), /abortStream must be a function/);
});
