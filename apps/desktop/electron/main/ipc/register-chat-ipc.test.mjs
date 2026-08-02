import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatIpcRegistrations } from './register-chat-ipc.mjs';

function createHarness(overrides = {}) {
  const calls = [];
  const port = (name) => (...args) => {
    calls.push([name, ...args]);
    return `${name}-result`;
  };
  const [registration] = createChatIpcRegistrations({
    chat: {
      send: port('send'),
      abort: port('abort'),
      reattach: port('reattach'),
      listActive: port('list-active'),
      compact: port('compact'),
      getCompaction: port('get-compaction'),
      contextRestored: port('context-restored'),
      ...overrides,
    },
  });
  const handlers = new Map();
  registration.register({
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  });
  return { calls, registration, handlers };
}

test('chat owner registers exactly the seven catalog channels', () => {
  const { handlers, registration } = createHarness();
  assert.equal(registration.owner, 'chat-ipc');
  assert.deepEqual([...handlers.keys()], [
    'chat:send',
    'chat:abort',
    'chat:stream:reattach',
    'chat:stream:list-active',
    'chat:compact',
    'chat:compaction:get',
    'chat:context:restored',
  ]);
});

test('chat owner projects sender and payload only where required', () => {
  const { calls, handlers } = createHarness();
  const sender = { id: 17 };
  const sendPayload = { streamId: 'stream-1', conversationId: 'conversation-1' };
  const compactPayload = { streamId: 'compact-1', conversationId: 'conversation-1' };
  const restoredPayload = { conversationId: 'conversation-1' };

  assert.equal(handlers.get('chat:send')({ sender }, sendPayload), 'send-result');
  assert.equal(handlers.get('chat:abort')({ sender }, { streamId: 'stream-1' }), 'abort-result');
  assert.equal(
    handlers.get('chat:stream:reattach')(
      { sender },
      { streamId: 'stream-1', conversationId: 'conversation-1' },
    ),
    'reattach-result',
  );
  assert.equal(handlers.get('chat:stream:list-active')({ sender }), 'list-active-result');
  assert.equal(handlers.get('chat:compact')({ sender }, compactPayload), 'compact-result');
  assert.equal(
    handlers.get('chat:compaction:get')({ sender }, { conversationId: 'conversation-1' }),
    'get-compaction-result',
  );
  assert.equal(
    handlers.get('chat:context:restored')({ sender }, restoredPayload),
    'context-restored-result',
  );

  assert.deepEqual(calls, [
    ['send', sendPayload, sender],
    ['abort', { streamId: 'stream-1' }],
    ['reattach', { streamId: 'stream-1', conversationId: 'conversation-1' }],
    ['list-active'],
    ['compact', compactPayload, sender],
    ['get-compaction', { conversationId: 'conversation-1' }],
    ['context-restored', restoredPayload, sender],
  ]);
});

test('chat owner preserves default empty payloads', () => {
  const { calls, handlers } = createHarness();
  const sender = { id: 17 };

  handlers.get('chat:send')({ sender });
  handlers.get('chat:abort')({ sender });
  handlers.get('chat:stream:reattach')({ sender });
  handlers.get('chat:compact')({ sender });
  handlers.get('chat:compaction:get')({ sender });
  handlers.get('chat:context:restored')({ sender });

  assert.deepEqual(calls, [
    ['send', {}, sender],
    ['abort', {}],
    ['reattach', {}],
    ['compact', {}, sender],
    ['get-compaction', {}],
    ['context-restored', {}, sender],
  ]);
});

test('chat owner fails fast when a required port is absent', () => {
  assert.throws(() => createChatIpcRegistrations(), /chat\.send/);
});
