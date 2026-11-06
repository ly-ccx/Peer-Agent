import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from '../sqlite/connection.mjs';
import { createResourceEditStorage } from './resource-edit-storage.mjs';
const hash = text => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const target = { recipient: { workspaceId: 'bot', conversationId: 'main' }, reference: { workspaceId: 'bot', path: '/not-opened-by-store/doc.md' }, base: { resourceId: hash('identity'), contentVersion: hash('base') } };
const view = { viewId: 'view', windowId: 'window', generation: 1, token: 'token' };
function fixture(t) {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'peer-resource-edit-')), stores = [];
  const create = () => { const store = createResourceEditStorage({ rootDir }); stores.push(store); return store; };
  t.after(() => { for (const store of stores) store.close(); rmSync(rootDir, { recursive: true, force: true }); });
  const store = create(), file = path.join(rootDir, 'bot', 'resource-edits', 'store.sqlite');
  const open = (id = 'draft', destination = target, baseText = 'base') => store.apply('bot', { type: 'open', id, target: destination, baseText });
  const acquire = id => store.apply('bot', { type: 'acquire', draftId: id, writer: view });
  return { store, create, open, acquire, file, rootDir };
}
test('device-local text survives reopening, only one live host owns writers, and old view leases are not restored', t => {
  const f = fixture(t); assert.equal(f.store.inspect('bot').manifest.drafts.length, 0); assert.equal(f.open().ok, true);
  const first = f.acquire('draft'); assert.equal(first.ok, true);
  assert.equal(f.store.apply('bot', { type: 'edit', draftId: 'draft', revision: 0, writer: first.writer, text: '用户草稿\r\n🙂' }).ok, true);
  const observer = f.create(); assert.equal(observer.readDraft('bot', 'draft').draft.text, '用户草稿\r\n🙂');
  assert.equal(observer.apply('bot', { type: 'acquire', draftId: 'draft', writer: { ...view, token: 'other' } }).code, 'RESOURCE_EDIT_HOST_BUSY');
  f.store.close(); const resumed = observer.readDraft('bot', 'draft'); assert.equal(resumed.draft.text, '用户草稿\r\n🙂');
  assert.equal(observer.apply('bot', { type: 'edit', draftId: 'draft', revision: 1, writer: first.writer, text: 'late' }).code, 'RESOURCE_EDIT_STALE_WRITER');
  assert.equal(statSync(f.file).mode & 0o777, 0o600);
});
test('manifest CAS and writer takeover protect later text; every response is a detached value', t => {
  const f = fixture(t); f.open(); const a = f.acquire('draft');
  const wrong = f.store.apply('bot', { type: 'edit', draftId: 'draft', revision: 0, writer: a.writer, text: 'wrong' }, { manifestRevision: 99 }); assert.equal(wrong.code, 'RESOURCE_EDIT_MANIFEST_CONFLICT');
  const b = f.store.apply('bot', { type: 'acquire', draftId: 'draft', writer: { ...view, viewId: 'second', token: 'second' }, takeover: true });
  assert.equal(f.store.apply('bot', { type: 'edit', draftId: 'draft', revision: 0, writer: a.writer, text: 'stale' }).code, 'RESOURCE_EDIT_STALE_WRITER');
  assert.equal(f.store.apply('bot', { type: 'edit', draftId: 'draft', revision: 0, writer: b.writer, text: '' }).ok, true);
  const result = f.store.readDraft('bot', 'draft'); result.draft.target.recipient.conversationId = 'tampered';
  assert.equal(f.store.readDraft('bot', 'draft').draft.target.recipient.conversationId, 'main');
});
test('prepared/running intent is not replayed on restore; reserved bytes retain original proposal after later editing', t => {
  const f = fixture(t); f.open(); const writer = f.acquire('draft').writer;
  f.store.apply('bot', { type: 'edit', draftId: 'draft', revision: 0, writer, text: 'proposal' });
  const reserved = f.store.apply('bot', { type: 'reserve', requestId: 'request', draftId: 'draft', revision: 1, writer, providerId: 'runtime.file', proposedVersion: hash('proposal') });
  assert.equal(reserved.execute, false);
  assert.equal(f.store.apply('bot', { type: 'start', requestId: 'request', payloadHash: reserved.operation.payloadHash }).execute, true);
  f.store.apply('bot', { type: 'edit', draftId: 'draft', revision: 1, writer, text: 'later user input' });
  assert.equal(f.store.operationText('bot', 'request').text, 'proposal'); f.store.close();
  const recovered = f.create(), state = recovered.inspect('bot'); assert.equal(state.manifest.operations[0].phase, 'uncertain');
  assert.equal(recovered.apply('bot', { type: 'start', requestId: 'request', payloadHash: reserved.operation.payloadHash }).code, 'RESOURCE_EDIT_RESULT_UNCERTAIN');
  assert.equal(recovered.readDraft('bot', 'draft').draft.text, 'later user input');
});
test('actual receipt projects retained before/after snapshots; cleanup never borrows a same-hash draft to revive cleared history', t => {
  const f = fixture(t); f.open(); const writer = f.acquire('draft').writer;
  const r = f.store.apply('bot', { type: 'reserve', requestId: 'request', draftId: 'draft', revision: 0, writer, providerId: 'runtime.file', proposedVersion: hash('base') });
  f.store.apply('bot', { type: 'start', requestId: 'request', payloadHash: r.operation.payloadHash });
  const receipt = { outcome: 'applied', observedVersion: hash('base'), toolCallId: 'actual-call', evidenceRef: 'evidence://actual' };
  assert.equal(f.store.apply('bot', { type: 'settle', requestId: 'request', receipt }).ok, true);
  const snapshots = f.store.listSnapshots('bot', { limit: 1 }); assert.equal(snapshots.items.length, 1); assert.ok(snapshots.nextCursor);
  assert.equal(f.store.readSnapshot('bot', snapshots.items[0].id).content, 'base');
  assert.equal(f.store.cleanup('bot', ['request']).ok, true);
  assert.equal(f.store.readSnapshot('bot', snapshots.items[0].id).code, 'RESOURCE_EDIT_BODY_CLEANED'); assert.equal(f.store.readDraft('bot', 'draft').draft.baseText, 'base');
  assert.equal(f.store.apply('bot', { type: 'archive', requestId: 'request' }).ok, true);
  assert.equal(f.store.apply('bot', { type: 'start', requestId: 'request', payloadHash: r.operation.payloadHash }).execute, false);
  assert.equal(f.store.inspect('bot').manifest.retiredOperations.length, 1);
});
test('superseded autosave blobs are reclaimed transactionally while current baseline and reserved operations stay intact', t => {
  const f = fixture(t); f.open(); const writer = f.acquire('draft').writer;
  for (let i = 0; i < 70; i++) assert.equal(f.store.apply('bot', { type: 'edit', draftId: 'draft', revision: i, writer, text: `revision-${i}` }).ok, true);
  const db = new DatabaseSync(f.file, { readOnly: true });
  try { assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM blobs').get().n), 2); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM host_owner').get().n, 1); }
  finally { db.close(); }
  assert.equal(f.store.readDraft('bot', 'draft').draft.text, 'revision-69');
});
test('future or corrupt storage fails without replacement; filesystem links cannot turn private intent into project writes', t => {
  const f = fixture(t); f.open(); f.store.close(); const db = new DatabaseSync(f.file); db.exec('PRAGMA user_version=99'); db.close();
  const before = readFileSync(f.file); assert.equal(f.create().readDraft('bot', 'draft').code, 'RESOURCE_EDIT_STORAGE_UNAVAILABLE'); assert.deepEqual(readFileSync(f.file), before);
  const g = fixture(t), outside = path.join(g.rootDir, 'outside'); writeFileSync(outside, 'do not modify');
  symlinkSync(outside, path.join(g.rootDir, 'bot')); assert.equal(g.open().code, 'RESOURCE_EDIT_STORAGE_UNAVAILABLE'); assert.equal(readFileSync(outside, 'utf8'), 'do not modify');
});
test('delivery snapshots require an exact retained version, explicit clearing preserves provenance and never opens the original path', t => {
  const f = fixture(t), snapshot = { id: 'fixed-delivery', target, version: hash('base'), purpose: 'delivery', availability: 'retained', evidenceRef: 'evidence://delivery', artifactRef: 'artifact://file', createdAt: '2026-10-27T00:00:00Z' };
  assert.equal(f.store.retainDelivery('bot', snapshot, 'different').code, 'RESOURCE_EDIT_INVALID_SNAPSHOT');
  assert.equal(f.store.retainDelivery('bot', snapshot, 'base').ok, true); assert.equal(f.store.readSnapshot('bot', snapshot.id).content, 'base');
  assert.equal(f.store.clearDelivery('bot', snapshot.id).ok, true); const result = f.store.readSnapshot('bot', snapshot.id);
  assert.equal(result.code, 'RESOURCE_EDIT_BODY_CLEANED'); assert.equal(result.snapshot.evidenceRef, snapshot.evidenceRef);
  assert.equal(f.store.listSnapshots('bot').items[0].availability, 'cleaned');
});
test('corrupt blob bytes cannot replace a recovered draft with a guessed body or a fresh empty database', t => {
  const f = fixture(t); f.open(); const db = new DatabaseSync(f.file);
  try { const body = Buffer.from('evil'); db.prepare('UPDATE blobs SET body=?,bytes=? WHERE digest=?').run(body, body.byteLength, hash('base')); } finally { db.close(); }
  assert.equal(f.store.readDraft('bot', 'draft').code, 'RESOURCE_EDIT_STORAGE_UNAVAILABLE');
  assert.equal(f.store.apply('bot', { type: 'acquire', draftId: 'draft', writer: view }).code, 'RESOURCE_EDIT_STORAGE_UNAVAILABLE');
  const check = new DatabaseSync(f.file, { readOnly: true });
  try { assert.equal(check.prepare('SELECT COUNT(*) AS n FROM manifest').get().n, 1); assert.equal(Buffer.from(check.prepare('SELECT body FROM blobs').get().body).toString(), 'evil'); } finally { check.close(); }
});
test('draft/operation caps reject new intent while explicit archival preserves replay protection and frees active slots', t => {
  const f = fixture(t); f.open(); const writer = f.acquire('draft').writer;
  for (let i = 0; i < 64; i++) {
    const id = `request-${i}`, r = f.store.apply('bot', { type: 'reserve', requestId: id, draftId: 'draft', revision: 0, writer, providerId: 'runtime.file', proposedVersion: hash('base') });
    assert.equal(r.ok, true); f.store.apply('bot', { type: 'start', requestId: id, payloadHash: r.operation.payloadHash });
    assert.equal(f.store.apply('bot', { type: 'settle', requestId: id, receipt: { outcome: 'failed' } }).ok, true);
  }
  const another = { type: 'reserve', requestId: 'next', draftId: 'draft', revision: 0, writer, providerId: 'runtime.file', proposedVersion: hash('base') };
  assert.equal(f.store.apply('bot', another).code, 'RESOURCE_EDIT_OPERATION_LIMIT');
  assert.equal(f.store.apply('bot', { type: 'archive', requestId: 'request-0' }).ok, true); assert.equal(f.store.apply('bot', another).ok, true);
  const old = f.store.apply('bot', { ...another, requestId: 'request-0' }); assert.equal(old.operation.phase, 'settled'); assert.equal(old.execute, false);
  for (let i = 1; i < 16; i++) assert.equal(f.open(`draft-${i}`, { ...target, reference: { ...target.reference, path: `/fixture/doc-${i}.md` }, base: { ...target.base, resourceId: hash(`identity-${i}`) } }).ok, true);
  assert.equal(f.open('overflow', { ...target, reference: { ...target.reference, path: '/fixture/overflow.md' } }).code, 'RESOURCE_EDIT_DRAFT_LIMIT');
  assert.equal(f.store.readDraft('bot', 'draft').draft.text, 'base');
});
test('retiring the last real view releases an idle workspace for another live host, keeping the saved draft', t => {
  const f = fixture(t); f.open(); f.acquire('draft'); const another = f.create();
  assert.equal(another.apply('bot', { type: 'acquire', draftId: 'draft', writer: { ...view, token: 'other' } }).code, 'RESOURCE_EDIT_HOST_BUSY');
  f.store.releaseView('bot', view);
  assert.equal(another.apply('bot', { type: 'acquire', draftId: 'draft', writer: { ...view, token: 'other' } }).ok, true);
  assert.equal(another.readDraft('bot', 'draft').draft.text, 'base');
});
