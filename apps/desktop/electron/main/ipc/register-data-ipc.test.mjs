import assert from 'node:assert/strict';
import test from 'node:test';
import { createDataIpcRegistrations } from './register-data-ipc.mjs';

function createHarness() {
  const calls = [];
  const port = (name) => (...args) => {
    calls.push([name, ...args]);
    return name;
  };
  const registrations = createDataIpcRegistrations({
    conversations: {
      list: port('conversations.list'),
      search: port('conversations.search'),
      create: port('conversations.create'),
      get: port('conversations.get'),
      updateTitle: port('conversations.updateTitle'),
      updateMode: port('conversations.updateMode'),
      updateFastMode: port('conversations.updateFastMode'),
      updatePreferredExecutionIsolation: port('conversations.updatePreferredExecutionIsolation'),
      updateModelEffort: port('conversations.updateModelEffort'),
      appendMessage: port('conversations.appendMessage'),
      updateLastMessage: port('conversations.updateLastMessage'),
      replaceMessages: port('conversations.replaceMessages'),
      archive: port('conversations.archive'),
      restore: port('conversations.restore'),
      pin: port('conversations.pin'),
      unpin: port('conversations.unpin'),
      reorderPinned: port('conversations.reorderPinned'),
      autoArchive: port('conversations.autoArchive'),
      remove: port('conversations.remove'),
      addUsage: port('conversations.addUsage'),
    },
    promptSnapshots: {
      list: port('prompt.list'),
      get: port('prompt.get'),
      listContextEpochs: port('prompt.listContextEpochs'),
      listContextEpochEvents: port('prompt.listContextEpochEvents'),
      getContextEpochChain: port('prompt.getContextEpochChain'),
    },
    usage: {
      stats: port('usage.stats'),
      daily: port('usage.daily'),
      day: port('usage.day'),
      cacheHitRate: port('usage.cacheHitRate'),
    },
  });
  const handlers = new Map();
  const owners = [];
  for (const descriptor of registrations) {
    owners.push(descriptor.owner);
    descriptor.register({
      handle(channel, listener) {
        assert.equal(handlers.has(channel), false, `duplicate handle: ${channel}`);
        handlers.set(channel, listener);
      },
    });
  }
  return { calls, handlers, owners };
}

const CONVERSATION_CHANNELS = [
  'conversations:add-usage',
  'conversations:append-message',
  'conversations:archive',
  'conversations:auto-archive',
  'conversations:create',
  'conversations:delete',
  'conversations:get',
  'conversations:list',
  'conversations:pin',
  'conversations:reorder-pinned',
  'conversations:replace-messages',
  'conversations:restore',
  'conversations:search',
  'conversations:unpin',
  'conversations:update-last-message',
  'conversations:update-mode',
  'conversations:update-fast-mode',
  'conversations:update-preferred-execution-isolation',
  'conversations:update-model-effort',
  'conversations:update-title',
];

test('data owners register the exact 27 invoke channels', () => {
  const { handlers, owners } = createHarness();
  assert.deepEqual(owners, [
    'conversations-ipc',
    'prompt-snapshots-ipc',
    'prompt-context-epochs-ipc',
    'usage-ipc',
  ]);
  assert.deepEqual([...handlers.keys()].sort(), [
    ...CONVERSATION_CHANNELS,
    'prompt-context-epochs:chain',
    'prompt-context-epochs:events',
    'prompt-context-epochs:list',
    'prompt-snapshots:get',
    'prompt-snapshots:list',
    'usage:daily',
    'usage:day',
    'usage:stats',
    'usage:cache-hit-rate',
  ].sort());
});

test('conversation handlers pass payloads and defaults without transport logic', () => {
  const { calls, handlers } = createHarness();
  const payload = { id: 'conv-1' };

  assert.equal(handlers.get('conversations:list')({}, undefined), 'conversations.list');
  for (const channel of CONVERSATION_CHANNELS.filter((name) => name !== 'conversations:list')) {
    assert.equal(handlers.get(channel)({}, payload), `conversations.${({
      'conversations:add-usage': 'addUsage',
      'conversations:append-message': 'appendMessage',
      'conversations:archive': 'archive',
      'conversations:auto-archive': 'autoArchive',
      'conversations:create': 'create',
      'conversations:delete': 'remove',
      'conversations:get': 'get',
      'conversations:pin': 'pin',
      'conversations:reorder-pinned': 'reorderPinned',
      'conversations:replace-messages': 'replaceMessages',
      'conversations:restore': 'restore',
      'conversations:search': 'search',
      'conversations:unpin': 'unpin',
      'conversations:update-last-message': 'updateLastMessage',
      'conversations:update-mode': 'updateMode',
      'conversations:update-fast-mode': 'updateFastMode',
      'conversations:update-preferred-execution-isolation': 'updatePreferredExecutionIsolation',
      'conversations:update-model-effort': 'updateModelEffort',
      'conversations:update-title': 'updateTitle',
    })[channel]}`);
  }
  assert.deepEqual(calls[0], ['conversations.list', {}]);
  assert.deepEqual(calls.at(-1), ['conversations.updateTitle', payload]);
});

test('prompt and usage handlers preserve legacy parameter projection', () => {
  const { calls, handlers } = createHarness();

  assert.equal(handlers.get('prompt-snapshots:list')({}, { limit: 5, ignored: true }), 'prompt.list');
  assert.equal(handlers.get('prompt-snapshots:get')({}, { id: 'snapshot' }), 'prompt.get');
  assert.equal(handlers.get('prompt-context-epochs:list')({}, { limit: 7 }), 'prompt.listContextEpochs');
  assert.equal(handlers.get('prompt-context-epochs:events')({}, {
    limit: 8,
    conversationId: 'conv',
    contextEpochId: 'epoch',
  }), 'prompt.listContextEpochEvents');
  assert.equal(handlers.get('prompt-context-epochs:chain')({}, {}), 'prompt.getContextEpochChain');
  assert.equal(handlers.get('usage:stats')({}), 'usage.stats');
  assert.equal(handlers.get('usage:daily')({}, undefined), 'usage.daily');
  assert.equal(handlers.get('usage:day')({}, { date: '2026-07-19', ignored: true }), 'usage.day');
  assert.equal(handlers.get('usage:cache-hit-rate')({}), 'usage.cacheHitRate');

  assert.deepEqual(calls, [
    ['prompt.list', { limit: 5 }],
    ['prompt.get', 'snapshot'],
    ['prompt.listContextEpochs', { limit: 7 }],
    ['prompt.listContextEpochEvents', {
      limit: 8,
      conversationId: 'conv',
      contextEpochId: 'epoch',
    }],
    ['prompt.getContextEpochChain', {
      conversationId: null,
      contextEpochId: null,
      limit: undefined,
    }],
    ['usage.stats'],
    ['usage.daily', { range: undefined }],
    ['usage.day', { date: '2026-07-19' }],
    ['usage.cacheHitRate'],
  ]);
});
