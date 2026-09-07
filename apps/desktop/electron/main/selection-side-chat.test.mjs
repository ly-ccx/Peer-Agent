import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConversationStore } from '../../../../packages/conversation-store/src/index.mjs';
import { selectionTextHash } from '../../../../packages/conversation-store/src/selection-reference.mjs';
import { createSelectionSideChatService } from './selection-side-chat-service.mjs';

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'peer-side-service-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createConversationStore({ storeDir: dir });
  const parent = store.createConversation({ title: 'parent' });
  store.appendMessage(parent.id, { id: 'm', role: 'assistant', content: 'source' });
  const caller = { conversationId: parent.id };
  let allowed = true;
  const runtime = new Map();
  const service = createSelectionSideChatService({ store,
    authorize: () => allowed,
    resolveRuntimeState: (id) => ({ conversationId: id,
      contentRevision: store.getPersistedConversationHistory(id).contentRevision,
      status: 'idle', ...runtime.get(id) }),
    now: () => '2026-09-06T10:00:00Z' });
  const request = { requestId: 'r', selection: { conversationId: parent.id, messageId: 'm', blockId: 'content',
    revision: store.getPersistedConversationHistory(parent.id).contentRevision,
    start: 0, end: 6, exactText: 'source', sourceTextHash: selectionTextHash('source') } };
  return { store, parent, caller, service, request, runtime, revoke: () => { allowed = false; } };
}

test('host service: create/list/read uses trusted identity and excludes drafts', async (t) => {
  const f = setup(t);
  const child = await f.service.create(f.caller, { ...f.request, parentConversationId: 'forged', runtimeState: { status: 'unknown' } });
  assert.equal(child.selectionOrigin.parentConversationId, f.parent.id);
  assert.equal((await f.service.create(f.caller, f.request)).id, child.id);
  const list = await f.service.list(f.caller);
  assert.equal(list.total, 1);
  assert.equal('selectionDraft' in list.items[0], false);
  assert.deepEqual((await f.service.read(f.caller, { childId: child.id })).messages, []);
  f.store.appendMessage(child.id, { id: 'u', role: 'user', content: 'question', permissionGrant: 'secret' });
  f.store.appendMessage(child.id, { id: 'a', role: 'assistant', content: 'unfinished' });
  f.runtime.set(child.id, { status: 'running', activeMessageId: 'a' });
  const read = await f.service.read(f.caller, { childId: child.id });
  assert.deepEqual(read.messages, [{ id: 'u', role: 'user', content: 'question' }]);
  assert.equal(read.runState, 'running');
  assert.equal(f.store.getConversation(child.id).messages.length, 2, 'read never rewrites history');
});

for (const sent of [false, true]) {
  for (const status of ['idle', 'running', 'error', 'unknown']) {
    test(`child discovery status: sent=${sent} x runtime=${status}`, async (t) => {
      const f = setup(t);
      const child = await f.service.create(f.caller, f.request);
      if (sent) f.store.appendMessage(child.id, { id: 'u', role: 'user', content: 'question' });
      f.runtime.set(child.id, { status });
      const page = await f.service.list(f.caller);
      assert.equal(page.items[0].lifecycle, sent ? 'active' : 'draft');
      assert.equal(page.items[0].runState, status);
      assert.equal(page.items[0].id, child.id);
      assert.equal('messages' in page.items[0], false);
      f.runtime.set(child.id, { status: 'running', contentRevision: -1 });
      assert.equal((await f.service.list(f.caller)).items[0].runState, 'unknown');
    });
  }
}

for (const limit of [1, 2]) {
  for (const maxCharacters of [1, 4]) {
    test(`child read budget: limit=${limit} x characters=${maxCharacters}`, async (t) => {
      const f = setup(t);
      const child = await f.service.create(f.caller, f.request);
      f.store.appendMessage(child.id, { id: 'u', role: 'user', content: 'ab' });
      f.store.appendMessage(child.id, { id: 'a', role: 'assistant', content: '😀😀' });
      const result = await f.service.read(f.caller, { childId: child.id, limit, maxCharacters });
      assert.ok(result.messages.length <= limit);
      assert.equal(result.characterCount, result.messages.reduce((n, m) => n + [...m.content].length, 0));
      assert.ok(result.characterCount <= maxCharacters);
      assert.equal(result.truncated, limit === 1 || maxCharacters === 1);
      if (maxCharacters === 1) {
        assert.deepEqual(result.messages, [{ id: 'a', role: 'assistant', content: '😀', contentTruncated: true }]);
      }
      await assert.rejects(f.service.read(f.caller, { childId: child.id, maxCharacters: 0 }), { code: 'SESSION_BUDGET_INVALID' });
    });
  }
}

for (const actor of ['self', 'parent', 'sibling']) {
  for (const allowed of [true, false]) {
    test(`draft ownership: actor=${actor} x allowed=${allowed}`, async (t) => {
      const f = setup(t);
      const child = await f.service.create(f.caller, f.request);
      const sibling = await f.service.create(f.caller, { ...f.request, requestId: 'sibling' });
      const conversationId = actor === 'self' ? child.id : actor === 'parent' ? f.parent.id : sibling.id;
      if (!allowed) f.revoke();
      const save = f.service.saveDraft({ conversationId }, { childId: child.id, text: 'saved draft', referenceIds: [] });
      if (allowed && actor === 'self') {
        assert.deepEqual(await save, { text: 'saved draft', references: [] });
        assert.equal(f.store.getConversation(child.id).selectionDraft.text, 'saved draft');
      } else {
        await assert.rejects(save, { code: allowed ? 'SESSION_DRAFT_NOT_OWNED' : 'SESSION_ACCESS_DENIED' });
        assert.equal(f.store.getConversation(child.id).selectionDraft.text, '');
      }
      assert.equal(f.store.getConversation(sibling.id).selectionDraft.text, '');
      assert.equal(f.store.getConversation(child.id).messages.length, 0);
    });
  }
}

test('host service: unrelated session and revoked access rejected', async (t) => {
  const f = setup(t);
  const other = f.store.createConversation({ title: 'unrelated' });
  await assert.rejects(f.service.read(f.caller, { childId: other.id }), { code: 'SESSION_NOT_DIRECT_CHILD' });
  await assert.rejects(f.service.list(f.caller, { limit: 101 }), { code: 'SESSION_PAGE_INVALID' });
  f.revoke();
  await assert.rejects(f.service.create(f.caller, f.request), { code: 'SESSION_ACCESS_DENIED' });
  await assert.rejects(f.service.list(f.caller), { code: 'SESSION_ACCESS_DENIED' });
  assert.equal(f.store.listSelectionChildren(f.parent.id).length, 0);
});
