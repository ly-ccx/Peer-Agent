import assert from 'node:assert/strict';
import test from 'node:test';
import { createProviderAccessIpcRegistrations } from './register-provider-access-ipc.mjs';

function createHarness() {
  const calls = [];
  const port = (name) => (...args) => {
    calls.push([name, ...args]);
    return name;
  };
  const registrations = createProviderAccessIpcRegistrations({
    providers: {
      quota: port('quota'),
      startOAuth: port('start-oauth'),
      openPendingOAuth: port('open-pending-oauth'),
      cancelOAuth: port('cancel-oauth'),
      listModels: port('list-models'),
      fetchModels: port('fetch-models'),
      dispose: port('dispose'),
    },
  });
  const handlers = new Map();
  const dispose = registrations[0].register({
    handle: (channel, handler) => handlers.set(channel, handler),
  });
  return { registrations, handlers, calls, dispose };
}

test('provider access IPC has one owner for the exact six-channel set', () => {
  const { registrations, handlers } = createHarness();
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].owner, 'provider-access-ipc');
  assert.deepEqual([...handlers.keys()].sort(), [
    'llm:models:fetch',
    'llm:models:list',
    'llm:oauth:cancel',
    'llm:oauth:open-pending',
    'llm:oauth:start',
    'llm:quota',
  ]);
});

test('provider access IPC preserves event and payload projections', async () => {
  const { handlers, calls, dispose } = createHarness();
  const sender = { id: 42 };
  await handlers.get('llm:quota')({}, { id: 'p1', force: true });
  await handlers.get('llm:oauth:start')({ sender }, { id: 'p1' });
  await handlers.get('llm:oauth:open-pending')({});
  await handlers.get('llm:oauth:cancel')({});
  await handlers.get('llm:models:list')({}, { id: 'p1' });
  await handlers.get('llm:models:fetch')({}, { channelId: 'openai' });
  dispose();
  assert.deepEqual(calls, [
    ['quota', 'p1', true],
    ['start-oauth', sender, { id: 'p1' }],
    ['open-pending-oauth'],
    ['cancel-oauth'],
    ['list-models', 'p1'],
    ['fetch-models', { channelId: 'openai' }],
    ['dispose'],
  ]);
});
