import assert from 'node:assert/strict';
import test from 'node:test';
import { createPendingTaskIpcRegistrations } from './register-pending-task-ipc.mjs';

function createHarness() {
  const calls = [];
  const port = (name) => (...args) => {
    calls.push([name, ...args]);
    return name;
  };
  const registrations = createPendingTaskIpcRegistrations({
    pendingTask: {
      write: port('write'),
      consume: port('consume'),
      peek: port('peek'),
      clear: port('clear'),
    },
  });
  const handlers = new Map();
  const ipc = {
    handle(channel, handler) {
      assert.equal(handlers.has(channel), false, `duplicate handler for ${channel}`);
      handlers.set(channel, handler);
    },
  };
  for (const registration of registrations) registration.register(ipc);
  return { calls, handlers, registrations };
}

test('pending task IPC has one owner for the exact channel set', () => {
  const { handlers, registrations } = createHarness();

  assert.deepEqual(registrations.map(({ owner }) => owner), ['pending-task-ipc']);
  assert.deepEqual([...handlers.keys()].sort(), [
    'pending-task:clear',
    'pending-task:consume',
    'pending-task:peek',
    'pending-task:write',
  ]);
});

test('pending task IPC preserves defaults, payloads, and results', async () => {
  const { calls, handlers } = createHarness();

  assert.equal(await handlers.get('pending-task:write')(null), 'write');
  const task = { sessionId: 'c1', task: 'continue' };
  assert.equal(await handlers.get('pending-task:write')(null, task), 'write');
  assert.equal(await handlers.get('pending-task:consume')(), 'consume');
  assert.equal(await handlers.get('pending-task:peek')(), 'peek');
  assert.equal(await handlers.get('pending-task:clear')(), 'clear');

  assert.deepEqual(calls, [
    ['write', {}],
    ['write', task],
    ['consume'],
    ['peek'],
    ['clear'],
  ]);
});
