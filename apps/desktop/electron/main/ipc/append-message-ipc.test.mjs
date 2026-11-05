import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

import { createConversationApplicationService } from '../conversation-application-service.mjs';
import { createConversationStore } from '../conversation-store.mjs';
import { createDataIpcRegistrations } from './register-data-ipc.mjs';

function requiredPorts(appendMessage) {
  const noop = () => null;
  return {
    listConversations: noop,
    listConversationsByWorkspace: noop,
    searchConversations: noop,
    createConversation: noop,
    getConversation: noop,
    updateTitle: noop,
    updateMode: noop,
    updateFastMode: noop,
    updatePreferredExecutionIsolation: noop,
    updateAutomationCreateContext: noop,
    updateModelEffort: noop,
    appendMessage,
    updateLastMessage: noop,
    replaceMessages: noop,
    archiveConversation: noop,
    restoreConversation: noop,
    pinConversation: noop,
    unpinConversation: noop,
    reorderPinnedConversations: noop,
    autoArchiveConversations: noop,
    deleteConversation: noop,
    addUsage: noop,
    listActiveConversationIds: () => [],
    deletePlanByConversation: noop,
    removeConversationToolArtifacts: noop,
    reportCascadeFailure: noop,
  };
}

test('classic append IPC response has no messages array and does not reread history', (t) => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'append-ipc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createConversationStore({ storeDir: dir });
  const conversation = store.createConversation({ title: 'classic' });
  store.appendMessage(conversation.id, {
    id: 'seed',
    role: 'assistant',
    content: 'historical body',
  }, { returnMessages: false });
  const historyFile = path.join(dir, `${conversation.id}.jsonl`);

  const service = createConversationApplicationService(requiredPorts(
    (id, message, options) => store.appendMessage(id, message, options),
  ));
  const handlers = new Map();
  for (const descriptor of createDataIpcRegistrations({
    conversations: service,
    promptSnapshots: {
      list: () => [],
      get: () => null,
      listContextEpochs: () => [],
      listContextEpochEvents: () => [],
      getContextEpochChain: () => null,
    },
    usage: {
      stats: () => ({}),
      daily: () => [],
      day: () => ({}),
      cacheHitRate: () => ({}),
    },
  })) {
    descriptor.register({
      handle(channel, listener) {
        handlers.set(channel, listener);
      },
    });
  }

  const original = fs.readFileSync;
  let historyReads = 0;
  t.mock.method(fs, 'readFileSync', (...args) => {
    if (args[0] === historyFile) historyReads += 1;
    return original.apply(fs, args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  const result = handlers.get('conversations:append-message')({}, {
    id: conversation.id,
    message: { id: 'next', role: 'user', content: 'continue' },
  });

  assert.equal(historyReads, 0);
  assert.equal(Object.hasOwn(result, 'messages'), false);
  assert.equal(Array.isArray(result.messages), false);
  assert.equal(result.messageCount, 2);
  assert.equal(result.contentRevision, 2);
  assert.deepEqual(
    store.getConversation(conversation.id).messages.map((row) => row.id),
    ['seed', 'next'],
  );
});
