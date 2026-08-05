import assert from 'node:assert/strict';
import test from 'node:test';
import { createProviderConfigurationIpcRegistrations } from './register-provider-configuration-ipc.mjs';

function createHarness() {
  const calls = [];
  const port = (name) => (...args) => {
    calls.push([name, ...args]);
    return name;
  };
  const registrations = createProviderConfigurationIpcRegistrations({
    providers: {
      listChannels: port('list-channels'),
      listServiceTemplates: port('list-service-templates'),
      listGroups: port('list-groups'),
      listProviders: port('list-providers'),
      listChatProviders: port('list-chat-providers'),
      add: port('add'),
      update: port('update'),
      duplicate: port('duplicate'),
      duplicateModel: port('duplicate-model'),
      addModel: port('add-model'),
      remove: port('remove'),
      removeGroup: port('remove-group'),
      setDefault: port('set-default'),
      test: port('test'),
      complete: port('complete'),
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

test('provider configuration IPC has one owner for the exact 15-channel set', () => {
  const { handlers, registrations } = createHarness();

  assert.deepEqual(registrations.map(({ owner }) => owner), ['provider-configuration-ipc']);
  assert.deepEqual([...handlers.keys()].sort(), [
    'llm:add',
    'llm:add-model',
    'llm:channels:list',
    'llm:chat:list',
    'llm:complete',
    'llm:duplicate',
    'llm:duplicate-model',
    'llm:groups:list',
    'llm:list',
    'llm:remove',
    'llm:remove-group',
    'llm:service-templates:list',
    'llm:set-default',
    'llm:test',
    'llm:update',
  ]);
});

test('provider configuration IPC preserves payload projections and results', async () => {
  const { calls, handlers } = createHarness();
  const config = { provider: 'openai', model: 'gpt' };

  assert.equal(await handlers.get('llm:channels:list')(), 'list-channels');
  assert.equal(await handlers.get('llm:groups:list')(), 'list-groups');
  assert.equal(await handlers.get('llm:list')(), 'list-providers');
  assert.equal(await handlers.get('llm:chat:list')(), 'list-chat-providers');
  assert.equal(await handlers.get('llm:add')(null, config), 'add');
  assert.equal(await handlers.get('llm:update')(null, { id: 'p1', model: 'm2' }), 'update');
  assert.equal(await handlers.get('llm:duplicate')(null, { id: 'p1' }), 'duplicate');
  assert.equal(await handlers.get('llm:duplicate-model')(null, { id: 'p1' }), 'duplicate-model');
  assert.equal(await handlers.get('llm:add-model')(null, { groupId: 'g1', model: 'm3' }), 'add-model');
  assert.equal(await handlers.get('llm:remove')(null, { id: 'p1' }), 'remove');
  assert.equal(await handlers.get('llm:remove-group')(null, { groupId: 'g1' }), 'remove-group');
  assert.equal(await handlers.get('llm:service-templates:list')(), 'list-service-templates');
  assert.equal(await handlers.get('llm:set-default')(null, { id: 'p2' }), 'set-default');
  assert.equal(await handlers.get('llm:test')(null, { id: 'p2' }), 'test');

  assert.deepEqual(calls, [
    ['list-channels'],
    ['list-groups'],
    ['list-providers'],
    ['list-chat-providers'],
    ['add', config],
    ['update', 'p1', { model: 'm2' }],
    ['duplicate', 'p1'],
    ['duplicate-model', 'p1'],
    ['add-model', 'g1', { model: 'm3' }],
    ['remove', 'p1'],
    ['remove-group', 'g1'],
    ['list-service-templates'],
    ['set-default', 'p2'],
    ['test', 'p2'],
  ]);
});
