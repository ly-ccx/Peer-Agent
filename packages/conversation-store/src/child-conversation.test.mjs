import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConversationStore } from './index.mjs';
import { selectionTextHash } from './selection-reference.mjs';

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'peer-child-role-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createConversationStore({ storeDir: dir });
  const parent = store.createConversation({ title: 'parent', workspacePath: '/workspace' });
  store.appendMessage(parent.id, { id: 'a', role: 'user', content: 'alpha' });
  store.appendMessage(parent.id, { id: 'b', role: 'assistant', content: 'beta anchor' });
  store.appendMessage(parent.id, { id: 'c', role: 'user', content: 'gamma after' });
  const history = store.getPersistedConversationHistory(parent.id);
  const runtimeState = {
    conversationId: parent.id,
    contentRevision: history.contentRevision,
    status: 'idle',
  };
  return { dir, store, parent, runtimeState, capturedAt: '2026-09-26T00:00:00.000Z' };
}

test('child conversation freezes history through the anchor and keeps role and parent', (t) => {
  const { dir, store, parent, runtimeState, capturedAt } = setup(t);
  const child = store.createChildConversation({
    parentConversationId: parent.id,
    role: 'work_session',
    anchorMessageId: 'b',
    title: 'task child',
    workspaceId: 'ws-1',
    delegation: { sessionId: 'session-1', anchorMessageId: 'b', inputId: 'input-1' },
    runtimeState,
    capturedAt,
  });
  assert.equal(child.role, 'work_session');
  assert.equal(child.parentConversationId, parent.id);
  assert.equal(child.workspaceId, 'ws-1');
  assert.deepEqual(child.delegation, {
    sessionId: 'session-1',
    anchorMessageId: 'b',
    inputId: 'input-1',
  });
  const snapshot = store.readInheritedBackground(child.backgroundSnapshotId);
  assert.deepEqual(snapshot.entries.map((entry) => entry.sourceMessageId), ['a', 'b']);
  assert.equal(snapshot.entries.some((entry) => entry.text.includes('gamma')), false);

  const again = createConversationStore({ storeDir: dir }).getConversation(child.id);
  assert.equal(again.role, 'work_session');
  assert.equal(again.parentConversationId, parent.id);
  assert.deepEqual(store.listChildren(parent.id, { role: 'work_session' }).map((row) => row.id), [child.id]);
  assert.deepEqual(store.listChildren(parent.id, { role: 'project_agent' }), []);
});

test('list and search hide task and bot rows unless roles are explicit', (t) => {
  const { dir, store, parent, runtimeState, capturedAt } = setup(t);
  const child = store.createChildConversation({
    parentConversationId: parent.id,
    role: 'work_session',
    anchorMessageId: 'b',
    title: 'hidden task',
    workspacePath: '/workspace',
    runtimeState,
    capturedAt,
  });
  const bot = store.createConversation({
    title: 'hidden bot',
    workspacePath: '/workspace',
    role: 'project_agent',
    workspaceId: 'ws-1',
  });
  const ordinary = store.createConversation({ title: 'visible chat', workspacePath: '/workspace' });

  appendFileSync(join(dir, 'index.jsonl'), `${JSON.stringify({
    id: 'legacy-plain',
    title: 'legacy plain',
    workspacePath: '/workspace',
    status: 'active',
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
  })}\n`);
  appendFileSync(join(dir, 'index.jsonl'), `${JSON.stringify({
    id: 'legacy-task',
    title: 'legacy task',
    workspacePath: '/workspace',
    role: 'work_session',
    parentConversationId: parent.id,
    status: 'active',
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-02T00:00:00.000Z',
  })}\n`);
  const legacy = createConversationStore({ storeDir: dir });

  const ids = (rows) => rows.map((row) => row.id);
  assert.deepEqual(ids(legacy.listConversations()).filter((id) => id !== parent.id).sort(), [ordinary.id, 'legacy-plain'].sort());
  assert.equal(ids(legacy.listConversationsByWorkspace('/workspace')).includes(child.id), false);
  assert.equal(ids(legacy.listConversationsByWorkspace('/workspace')).includes(bot.id), false);
  assert.equal(ids(legacy.searchConversations({ query: 'hidden' })).includes(child.id), false);
  assert.equal(ids(legacy.searchConversations({ query: 'hidden bot' })).includes(bot.id), false);
  assert.equal(ids(legacy.searchConversations({ query: 'legacy plain' })).includes('legacy-plain'), true);

  const explicit = ids(legacy.listConversations({ roles: ['work_session', 'project_agent'] }));
  assert.ok(explicit.includes(child.id));
  assert.ok(explicit.includes(bot.id));
  assert.ok(explicit.includes('legacy-task'));
  assert.equal(explicit.includes(ordinary.id), false);
  assert.ok(ids(legacy.searchConversations({
    roles: ['project_agent'],
    query: 'hidden bot',
  })).includes(bot.id));
  assert.deepEqual(legacy.listConversations({ roles: ['not-a-role'] }), []);
  assert.ok(ids(legacy.listChildren(parent.id)).includes('legacy-task'));
  assert.equal(ids(legacy.listChildren(parent.id, { role: 'work_session' })).includes(child.id), true);
});

test('selection children stay ordinary and remain discoverable as children', (t) => {
  const { dir, store, parent } = setup(t);
  const revision = store.getPersistedConversationHistory(parent.id).contentRevision;
  const selection = {
    conversationId: parent.id,
    messageId: 'b',
    blockId: 'content',
    revision,
    start: 0,
    end: 4,
    exactText: 'beta',
    sourceTextHash: selectionTextHash('beta anchor'),
  };
  const side = store.createSelectionChild({
    parentConversationId: parent.id,
    requestId: 'side-1',
    capturedAt: '2026-09-26T00:00:00.000Z',
    runtimeState: { conversationId: parent.id, contentRevision: revision, status: 'idle' },
    selection,
  });
  assert.equal(side.role, undefined);
  assert.equal(side.parentConversationId, parent.id);
  assert.equal(side.selectionOrigin.parentConversationId, parent.id);
  assert.ok(store.listConversations().some((row) => row.id === side.id));
  assert.ok(store.listChildren(parent.id).some((row) => row.id === side.id));

  const indexPath = join(dir, 'index.jsonl');
  const rows = readFileSync(indexPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const stored = rows.find((row) => row.id === side.id);
  delete stored.parentConversationId;
  writeFileSync(indexPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const reloaded = createConversationStore({ storeDir: dir });
  assert.ok(reloaded.listChildren(parent.id).some((row) => row.id === side.id));
  assert.equal(reloaded.listChildren(parent.id).find((row) => row.id === side.id).role, undefined);
});

test('child creation rejects a bad role, anchor, or delegation', (t) => {
  const { store, parent, runtimeState, capturedAt } = setup(t);
  assert.throws(() => store.createConversation({ role: 'bot' }), { code: 'CONVERSATION_ROLE_INVALID' });
  assert.throws(() => store.createChildConversation({
    parentConversationId: parent.id,
    role: 'side_chat',
    anchorMessageId: 'b',
    runtimeState,
    capturedAt,
  }), { code: 'CONVERSATION_ROLE_INVALID' });
  assert.throws(() => store.createChildConversation({
    parentConversationId: parent.id,
    role: 'work_session',
    anchorMessageId: 'missing',
    runtimeState,
    capturedAt,
  }), { code: 'CHILD_ANCHOR_MISSING' });
  assert.throws(() => store.createChildConversation({
    parentConversationId: parent.id,
    role: 'work_session',
    anchorMessageId: 'b',
    delegation: { sessionId: 'only-session' },
    runtimeState,
    capturedAt,
  }), { code: 'CHILD_DELEGATION_INVALID' });
  assert.equal(store.listConversations({ roles: ['work_session', 'project_agent'] }).length, 0);
});
