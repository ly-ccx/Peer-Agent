import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversationApplicationService } from './conversation-application-service.mjs';

function createHarness(overrides = {}) {
  const calls = [];
  const port = (name, result = name) => (...args) => {
    calls.push([name, ...args]);
    return result;
  };
  const service = createConversationApplicationService({
    listConversations: port('list'),
    listConversationsByWorkspace: port('list-workspace'),
    searchConversations: port('search'),
    createConversation: port('create'),
    getConversation: port('get'),
    updateTitle: port('update-title'),
    updateMode: port('update-mode'),
    updateAutomationCreateContext: port('update-automation-create-context'),
    updateModelEffort: port('update-model-effort'),
    appendMessage: port('append-message'),
    updateLastMessage: port('update-last-message'),
    replaceMessages: port('replace-messages'),
    archiveConversation: port('archive'),
    restoreConversation: port('restore'),
    pinConversation: port('pin'),
    unpinConversation: port('unpin'),
    reorderPinnedConversations: port('reorder-pinned'),
    autoArchiveConversations: port('auto-archive'),
    deleteConversation: port('delete', { deleted: true }),
    addUsage: port('add-usage'),
    listActiveConversationIds: () => ['active', 'shared'],
    deletePlanByConversation: port('delete-plans'),
    removeConversationToolArtifacts: port('remove-artifacts'),
    reportCascadeFailure: port('cascade-failure'),
    ...overrides,
  });
  return { calls, service };
}

test('list preserves legacy pagination and workspace projection', () => {
  const { calls, service } = createHarness();

  assert.equal(service.list({ status: 'active' }), 'list');
  assert.equal(service.list({ workspacePath: '/repo', limit: 20, cursor: 'next' }), 'list-workspace');
  assert.deepEqual(calls, [
    ['list', {
      status: 'active',
      includeMessageCount: undefined,
      backfillMessageCount: undefined,
      limit: undefined,
      cursor: undefined,
      paginated: false,
    }],
    ['list-workspace', '/repo', {
      status: undefined,
      includeMessageCount: undefined,
      backfillMessageCount: undefined,
      limit: 20,
      cursor: 'next',
      paginated: true,
    }],
  ]);
});

test('auto archive merges caller exclusions with active streams without duplicates', () => {
  const { calls, service } = createHarness();

  assert.equal(service.autoArchive({ before: 100, excludeIds: ['caller', 'shared'] }), 'auto-archive');
  assert.deepEqual(calls, [
    ['auto-archive', { before: 100, excludeIds: ['caller', 'shared', 'active'] }],
  ]);
});

test('delete preserves delete-first order and degrades both cascade failures', () => {
  const calls = [];
  const goalError = new Error('goal cleanup failed');
  const artifactError = new Error('artifact cleanup failed');
  const { service } = createHarness({
    deleteConversation(id) {
      calls.push(['delete', id]);
      return { id, deleted: true };
    },
    deletePlanByConversation(id) {
      calls.push(['delete-plans', id]);
      throw goalError;
    },
    removeConversationToolArtifacts(payload) {
      calls.push(['remove-artifacts', payload]);
      throw artifactError;
    },
    reportCascadeFailure(operation, error) {
      calls.push(['warn', operation, error]);
    },
  });

  assert.deepEqual(service.remove({ id: 'conv-1' }), { id: 'conv-1', deleted: true });
  assert.deepEqual(calls, [
    ['delete', 'conv-1'],
    ['delete-plans', 'conv-1'],
    ['warn', 'deletePlanByConversation', goalError],
    ['remove-artifacts', { conversationId: 'conv-1' }],
    ['warn', 'removeConversationToolArtifacts', artifactError],
  ]);
});

test('conversation commands preserve payload mapping and return values', () => {
  const { calls, service } = createHarness();

  assert.equal(service.search(undefined), 'search');
  assert.equal(service.create({ title: 'T' }), 'create');
  assert.equal(service.get({ id: 'c' }), 'get');
  assert.equal(service.updateTitle({ id: 'c', title: 'New' }), 'update-title');
  assert.equal(service.updateMode({ id: 'c', mode: 'goal' }), 'update-mode');
  assert.equal(
    service.updateModelEffort({ id: 'c', effort: 'high', modelProviderId: 'provider' }),
    'update-model-effort',
  );
  assert.equal(service.appendMessage({ id: 'c', message: { role: 'user' } }), 'append-message');
  assert.equal(service.updateLastMessage({ id: 'c', content: 'x' }), 'update-last-message');
  assert.equal(service.replaceMessages({ id: 'c', messages: [], allowEmpty: true }), 'replace-messages');
  assert.equal(service.archive({ id: 'c' }), 'archive');
  assert.equal(service.restore({ id: 'c' }), 'restore');
  assert.equal(service.pin({ id: 'c' }), 'pin');
  assert.equal(service.unpin({ id: 'c' }), 'unpin');
  assert.equal(service.reorderPinned({ ids: ['b', 'a'] }), 'reorder-pinned');
  assert.equal(service.addUsage({ id: 'c', usage: { input: 1 } }), 'add-usage');

  assert.deepEqual(calls, [
    ['search', {}],
    ['create', { title: 'T' }],
    ['get', 'c'],
    ['update-title', 'c', 'New'],
    ['update-mode', 'c', 'goal'],
    ['update-model-effort', 'c', { effort: 'high', modelProviderId: 'provider' }],
    ['append-message', 'c', { role: 'user' }],
    ['update-last-message', 'c', 'x'],
    ['replace-messages', 'c', [], { allowEmpty: true }],
    ['archive', 'c'],
    ['restore', 'c'],
    ['pin', 'c'],
    ['unpin', 'c'],
    ['reorder-pinned', ['b', 'a']],
    ['add-usage', 'c', { input: 1 }],
  ]);
});
