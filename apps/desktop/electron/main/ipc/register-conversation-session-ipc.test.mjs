import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversationSessionIpcRegistrations } from './register-conversation-session-ipc.mjs';

test('conversation session owner registers set-active and projects the payload unchanged', () => {
  const calls = [];
  const payload = { conversationId: 'conversation-1', planId: 'plan-1' };
  const [registration] = createConversationSessionIpcRegistrations({
    conversationSession: {
      setActiveConversation(value) {
        calls.push(value);
        return { ok: true, conversationId: value.conversationId };
      },
    },
  });
  const handlers = new Map();

  registration.register({
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  });

  assert.equal(registration.owner, 'conversation-ipc');
  assert.deepEqual([...handlers.keys()], ['conversation:set-active']);
  assert.deepEqual(handlers.get('conversation:set-active')({ sender: { id: 1 } }, payload), {
    ok: true,
    conversationId: 'conversation-1',
  });
  assert.deepEqual(calls, [payload]);
});

test('conversation session owner preserves the default empty payload', () => {
  const calls = [];
  const [registration] = createConversationSessionIpcRegistrations({
    conversationSession: {
      setActiveConversation(payload) {
        calls.push(payload);
        return payload;
      },
    },
  });
  const handlers = new Map();

  registration.register({
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  });

  assert.deepEqual(handlers.get('conversation:set-active')({}), {});
  assert.deepEqual(calls, [{}]);
});

test('conversation session owner fails fast when its service port is missing', () => {
  assert.throws(
    () => createConversationSessionIpcRegistrations(),
    /conversationSession\.setActiveConversation must be a function/,
  );
});
