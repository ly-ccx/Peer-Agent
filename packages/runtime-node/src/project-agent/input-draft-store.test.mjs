import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectInputRecovery } from '@peer-agent/runtime-core';
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

test('real store + recovery heals pre-existing stuck desktop.json via discard, handles CAS conflict honestly, and restores attachments atomically', async t => {
  const { root, store } = fixture(t);
  const file = path.join(root, address.workspaceId, 'input-drafts/desktop.json');
  mkdirSync(path.dirname(file), { recursive: true });
  const stuckId = '5c17d46f-ac61-4b0f-a8b7-dddfd37fe1d7';
  writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    revision: 3425,
    draft: { text: '', quote: null, attachmentIds: [] },
    pending: [{
      inputId: stuckId,
      text: '排查并修复 macOS 流式超时（推荐）',
      createdAt: '2026-11-27T03:06:38.383Z',
      quoteRefs: [],
      answerTo: 'card:question:reply:reply-tc-1',
      attachmentIds: [],
    }],
    uploads: {},
  }));

  const makeSession = () => createProjectInputRecovery({
    workspaceId: address.workspaceId,
    surface: 'desktop',
    createId: () => 'next-id',
    port: {
      read: async req => store.read(req),
      write: async req => store.write(req),
      submit: async () => ({ ok: false, code: 'QUESTION_CLOSED' }),
    },
  });

  // 1. Stale revision (external concurrent write) causes discard to fail honestly without hiding the stuck item.
  const stale = makeSession();
  assert.equal(await stale.load(), true);
  assert.equal(stale.getSnapshot().pending.length, 1);
  assert.equal(store.write({
    ...address,
    revision: 3425,
    draft: { text: 'other window edit', quote: null, attachmentIds: [] },
    pending: [{
      inputId: stuckId,
      text: '排查并修复 macOS 流式超时（推荐）',
      createdAt: '2026-11-27T03:06:38.383Z',
      quoteRefs: [],
      answerTo: 'card:question:reply:reply-tc-1',
      attachmentIds: [],
    }],
    uploads: [],
  }).ok, true);
  assert.deepEqual(await stale.discard(stuckId), { ok: false, code: 'DRAFT_CONFLICT' });
  assert.equal(stale.getSnapshot().pending.length, 1);
  assert.equal(stale.getSnapshot().error, 'DRAFT_CONFLICT');

  // 2. Fresh session retries -> QUESTION_CLOSED transitions to rejected -> discard persists cleanly across reload.
  const fresh = makeSession();
  assert.equal(await fresh.load(), true);
  assert.equal((await fresh.retry(stuckId)).code, 'QUESTION_CLOSED');
  assert.equal(fresh.getSnapshot().rejected[stuckId], 'QUESTION_CLOSED');
  assert.deepEqual(await fresh.discard(stuckId), { ok: true });
  assert.equal(fresh.getSnapshot().pending.length, 0);
  const reloaded = store.read(address);
  assert.equal(reloaded.ok, true);
  assert.equal(reloaded.snapshot.revision, 3427);
  assert.equal(reloaded.snapshot.pending.length, 0);
  assert.equal(reloaded.snapshot.draft.text, 'other window edit');

  // 3. Restoring an unknown pending item with an attachment keeps the blob and atomically clears pending on disk.
  const withFile = createProjectInputRecovery({
    workspaceId: address.workspaceId,
    surface: 'desktop',
    createId: () => 'with-file-id',
    port: {
      read: async req => store.read(req),
      write: async req => store.write(req),
      submit: async () => ({ ok: false, code: 'INPUT_OUTCOME_UNKNOWN' }),
    },
  });
  assert.equal(await withFile.load(), true);
  withFile.edit({ text: 'with file', attachments: [attachment] });
  await withFile.flush();
  assert.equal((await withFile.send()).code, 'INPUT_OUTCOME_UNKNOWN');
  assert.equal(withFile.getSnapshot().pending.length, 1);
  assert.equal(withFile.getSnapshot().draft.text, '');
  assert.deepEqual(await withFile.restoreToDraft('with-file-id'), { ok: true });
  assert.equal(withFile.getSnapshot().pending.length, 0);
  assert.equal(withFile.getSnapshot().draft.text, 'with file');
  assert.deepEqual(withFile.getSnapshot().draft.attachments, [attachment]);
  const afterRestore = store.read(address);
  assert.equal(afterRestore.ok, true);
  assert.equal(afterRestore.snapshot.pending.length, 0);
  assert.equal(afterRestore.snapshot.draft.text, 'with file');
  assert.deepEqual(afterRestore.snapshot.draft.attachments, [attachment]);
});
