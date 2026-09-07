import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConversationStore } from './index.mjs';
import { selectionTextHash } from './selection-reference.mjs';

for (const deleteTarget of ['parent', 'child']) {
  test(`child open persists identity/draft, retry, reopen, delete ${deleteTarget}`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'peer-child-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    let store = createConversationStore({ storeDir: dir });
    const parent = store.createConversation({ title: 'parent', workspacePath: '/workspace', mode: 'plan' });
    store.appendMessage(parent.id, { id: 'm', role: 'assistant', content: 'original text' });
    const revision = store.getPersistedConversationHistory(parent.id).contentRevision;
    const request = { parentConversationId: parent.id, requestId: 'open-1',
      capturedAt: '2026-09-06T10:00:00Z',
      runtimeState: { conversationId: parent.id, contentRevision: revision, status: 'idle' },
      selection: { conversationId: parent.id, messageId: 'm', blockId: 'content', revision,
        start: 0, end: 8, exactText: 'original', sourceTextHash: selectionTextHash('original text') } };
    const child = store.createSelectionChild({ ...request,
      selection: { ...request.selection, permissionGrant: 'do-not-copy', runner: { active: true } } });
    assert.equal(JSON.stringify(child).includes('do-not-copy'), false);
    assert.equal('runner' in child.selectionOrigin.requestSelection, false);
    const reordered = Object.fromEntries(Object.entries(request.selection).reverse());
    assert.equal(store.createSelectionChild({ ...request, selection: reordered }).id, child.id);
    assert.notEqual(child.id, parent.id);
    assert.equal(child.selectionOrigin.parentConversationId, parent.id);
    assert.equal(child.selectionDraft.references[0].exactText, 'original');
    assert.equal(store.getConversation(child.id).messages.length, 0);
    assert.equal(store.createSelectionChild(request).id, child.id);
    assert.equal(store.listSelectionChildren(parent.id).length, 1);
    assert.equal('selectionDraft' in store.listSelectionChildren(parent.id)[0], false);
    store = createConversationStore({ storeDir: dir });
    assert.equal(store.createSelectionChild(request).id, child.id);
    assert.equal(store.getConversation(child.id).selectionDraft.references[0].exactText, 'original');
    const second = store.createSelectionChild({ ...request, requestId: 'open-2' });
    assert.notEqual(second.id, child.id);
    const parentBeforeDraft = store.getConversation(parent.id);
    store.updateSelectionChildDraft(child.id, { text: 'unsent question', referenceIds: [] });
    store = createConversationStore({ storeDir: dir });
    assert.deepEqual(store.getConversation(child.id).selectionDraft, { text: 'unsent question', references: [] });
    assert.equal(store.getConversation(child.id).contentRevision, 0);
    assert.equal(store.getConversation(child.id).selectionOrigin.reference.exactText, 'original');
    assert.equal(store.getConversation(second.id).selectionDraft.text, '');
    assert.deepEqual(store.getConversation(parent.id), parentBeforeDraft);
    assert.throws(() => store.updateSelectionChildDraft(child.id, { text: 'bad', referenceIds: ['foreign'] }), { code: 'CHILD_DRAFT_REFERENCE_INVALID' });
    assert.equal(store.getConversation(child.id).selectionDraft.text, 'unsent question');
    store.updateSelectionChildDraft(child.id, { text: 'unsent question', referenceIds: [child.selectionOrigin.reference.id] });
    assert.equal(store.getConversation(child.id).selectionDraft.references.length, 1);
    assert.equal(store.listSelectionChildren(parent.id).length, 2);
    assert.throws(() => store.createSelectionChild({ ...request, selection: { ...request.selection, end: 7 } }), { code: 'CHILD_REQUEST_CONFLICT' });
    store.deleteConversation(deleteTarget === 'parent' ? parent.id : child.id);
    if (deleteTarget === 'parent') {
      assert.equal(store.getConversation(child.id).selectionOrigin.parentConversationId, parent.id);
      assert.ok(store.readInheritedBackground(child.selectionOrigin.snapshotId));
    } else {
      assert.ok(store.getConversation(parent.id));
      assert.equal(store.listSelectionChildren(parent.id).length, 1);
    }
  });
}
