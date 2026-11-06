import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectInputDraftStore } from './input-draft-store.mjs';

const address = { workspaceId: 'ws-a', surface: 'desktop' };
const attachment = { id: 'upload-one', kind: 'text', name: 'a.txt', mimeType: 'text/plain', size: 5, text: 'hello', sourceKind: 'user_upload' };
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-input-draft-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createProjectInputDraftStore({ rootDir: root });
  return { root, store, request: { ...address, revision: 0, draft: { text: '草稿', quote: { messageId: 'message-a', text: '引用' }, attachmentIds: [attachment.id] },
    pending: [{ inputId: 'same-input', text: '原消息', createdAt: '2026-10-23T08:00:00Z', answerTo: 'card:question:a', quoteRefs: ['message-a'], attachmentIds: [attachment.id] }], uploads: [attachment] } };
}
test('draft, quote, attachments and unconfirmed envelope survive reopening without executing anything', t => {
  const { root, store, request } = fixture(t);
  assert.equal(store.write(request).ok, true);
  const reopened = createProjectInputDraftStore({ rootDir: root }).read(address);
  assert.equal(reopened.ok, true);
  assert.equal(reopened.snapshot.revision, 1);
  assert.equal(reopened.snapshot.draft.text, '草稿');
  assert.deepEqual(reopened.snapshot.draft.quote, request.draft.quote);
  assert.deepEqual(reopened.snapshot.draft.attachments, [attachment]);
  assert.equal(reopened.snapshot.pending[0].inputId, 'same-input');
  assert.deepEqual(reopened.snapshot.pending[0].attachments, [attachment]);
  assert.equal(readdirSync(path.join(root, address.workspaceId)).includes('input-queue.jsonl'), false);
  assert.equal(store.read({ ...address, surface: 'quick_chat' }).snapshot.draft.text, '');
  assert.equal(store.read({ ...address, workspaceId: 'ws-b' }).snapshot.pending.length, 0);
});
test('text edits reuse blobs and stale writers cannot overwrite either draft or pending', t => {
  const { root, store, request } = fixture(t);
  assert.deepEqual(store.write(request), { ok: true, revision: 1 });
  const file = path.join(root, address.workspaceId, 'input-drafts/desktop.json');
  assert.equal(readFileSync(file, 'utf8').includes('"text":"hello"'), false);
  const blobFiles = readdirSync(path.join(root, address.workspaceId, 'input-draft-blobs'));
  assert.deepEqual(store.write({ ...request, revision: 1, draft: { ...request.draft, text: '编辑' }, uploads: [] }), { ok: true, revision: 2 });
  assert.deepEqual(readdirSync(path.join(root, address.workspaceId, 'input-draft-blobs')), blobFiles);
  assert.deepEqual(store.write(request), { ok: false, code: 'DRAFT_CONFLICT' });
  assert.equal(store.read(address).snapshot.draft.text, '编辑');
  assert.equal(store.read(address).snapshot.pending[0].text, '原消息');
});
test('corrupt manifests are reported and preserved, rather than treated as empty', t => {
  const { root, store, request } = fixture(t);
  const file = path.join(root, address.workspaceId, 'input-drafts/desktop.json');
  mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, '{broken');
  assert.equal(store.read(address).ok, false);
  assert.equal(store.write(request).ok, false);
  assert.equal(readFileSync(file, 'utf8'), '{broken');
});
test('invalid targets, remote surfaces, missing blobs and changed attachment identities cannot be saved', t => {
  const { store, request } = fixture(t);
  assert.equal(store.write({ ...request, workspaceId: '../escape' }).ok, false);
  assert.equal(store.write({ ...request, surface: 'remote' }).ok, false);
  assert.equal(store.write({ ...request, uploads: [] }).ok, false);
  assert.equal(store.write(request).ok, true);
  assert.equal(store.write({ ...request, revision: 1, uploads: [{ ...attachment, text: 'different' }] }).ok, false);
  assert.equal(store.read(address).snapshot.draft.attachments[0].text, 'hello');
});
test('a live writer lock is not stolen', t => {
  const { root, store, request } = fixture(t);
  const lock = path.join(root, address.workspaceId, 'input-drafts/desktop.json.lock');
  mkdirSync(lock, { recursive: true }); writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
  assert.deepEqual(store.write(request), { ok: false, code: 'DRAFT_BUSY' });
  assert.equal(readFileSync(path.join(lock, 'owner.json'), 'utf8'), JSON.stringify({ pid: process.pid }));
});
