import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateDraft } from '@peer-agent/interactive-content';
import { DatabaseSync } from '../sqlite/connection.mjs';
import { createInteractiveResultStore } from './store.mjs';

const owner = { workspaceId: 'bot-a', conversationId: 'parent-a' };
const now = () => '2026-11-03T00:00:00.000Z';
const source = { conversationId: 'worker-a', planId: 'plan-a', sessionId: 'session-a', executionEpoch: 'epoch-a', toolCallId: 'publish-a' };
const draft = { publication: { kind: 'create' }, title: 'Trial', textFallback: 'Model trial.', program: '$x=2\nroot=Col([Metric("x",$x*3)])', inputs: [] };
async function candidate(call = source.toolCallId, patch = {}) {
  const nextDraft = { ...draft, ...patch };
  return { owner, source: { ...source, toolCallId: call }, draft: nextDraft, content: await validateDraft(nextDraft), provenance: [],
    grant: { grantId: 'grant-a', granted: true, toolCallId: call }, dataLevel: 'D2_sensitive' };
}
function fixture(t, options = {}) {
  const rootDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'peer-interactive-store-')));
  const store = createInteractiveResultStore({ rootDir, now, assertCompatibility: () => true, ...options });
  t.after(() => { store.close(); rmSync(rootDir, { recursive: true, force: true }); });
  return { rootDir, store };
}
const current = () => true;

test('owner privacy is monotonic, isolated and durable; a missing or invalid floor cannot silently lower stored facts', async t => {
  const { store, rootDir } = fixture(t);
  assert.equal(store.ownerDataLevel(owner, 'D3_private'), 'D3_private');
  assert.equal(store.storage.connect(owner.workspaceId), null);
  store.rememberObservationLevel(owner, 'D4_regulated', current);
  store.rememberObservationLevel(owner, 'D1_internal', current);
  assert.equal(store.ownerDataLevel(owner, 'D0_public'), 'D4_regulated');
  assert.equal(store.ownerDataLevel({ ...owner, conversationId: 'other-owner' }, 'D1_internal'), 'D1_internal');
  assert.throws(() => store.rememberObservationLevel(owner, 'D4_regulated', () => false), { code: 'interactive_execution_stale' });
  store.close();
  const reopened = createInteractiveResultStore({ rootDir, now, assertCompatibility: () => true });
  t.after(() => reopened.close());
  assert.equal(reopened.ownerDataLevel(owner, 'D2_sensitive'), 'D4_regulated');
  reopened.storage.connect(owner.workspaceId, true).db.prepare("UPDATE owner_privacy SET dataLevel='unknown'").run();
  assert.throws(() => reopened.ownerDataLevel(owner, 'D3_private'), { code: 'material_classification_unavailable' });
  reopened.storage.connect(owner.workspaceId, true).db.prepare('DELETE FROM owner_privacy').run();
  reopened.recordMaterial({ owner, source: { kind: 'tool-result', conversationId: 'worker-a', toolCallId: 'read-a' }, value: { payload: [1] },
    dataLevel: 'D4_regulated', observedAt: now(), truncated: false, redacted: false, evidenceRefs: ['tool-result://read-a'] }, current);
  reopened.storage.connect(owner.workspaceId, true).db.prepare('DELETE FROM owner_privacy').run();
  assert.throws(() => reopened.ownerDataLevel(owner, 'D3_private'), { code: 'material_classification_unavailable' });
});

test('publication persists one version/operation/outbox and is not formally available until real index confirmation', async t => {
  const { store } = fixture(t);
  const receipt = store.commitPublication(await candidate(), current);
  assert.equal(receipt.publicationStatus, 'index_pending');
  assert.equal(store.listPending(owner).length, 1);
  assert.throws(() => store.getVersion(receipt.reference), { code: 'publication_index_pending' });
  assert.equal(store.getVersion(receipt.reference, { allowPending: true }).content.program, draft.program);
  const indexed = store.markIndexed(receipt.callRef, receipt.indexEntry);
  assert.equal(indexed.publicationStatus, 'published');
  assert.equal(store.listPending(owner).length, 0);
  const published = store.getVersion(receipt.reference);
  assert.equal(published.evidenceRef, receipt.metadata.artifactRef);
  assert.equal(published.content.tree, undefined, 'derived render cache is not stored as a second content truth');
});

test('a crash after commit recovers the same receipt without republishing and requires the same source in the index', async t => {
  let crash = true;
  const { store, rootDir } = fixture(t, { onStep: stage => { if (stage === 'committed' && crash) throw Error('simulated process loss'); } });
  const input = await candidate();
  assert.throws(() => store.commitPublication(input, current), /simulated process loss/);
  crash = false;
  const prior = store.getOperation({ owner, conversationId: source.conversationId, toolCallId: source.toolCallId });
  assert.equal(prior.publicationStatus, 'index_pending');
  store.close();
  const reopened = createInteractiveResultStore({ rootDir, now, assertCompatibility: () => true });
  t.after(() => reopened.close());
  const retry = reopened.commitPublication(input, current);
  assert.deepEqual(retry.reference, prior.reference);
  assert.equal(reopened.listPending(owner).length, 1);
  assert.throws(() => reopened.markIndexed(prior.callRef, { ...prior.indexEntry, planId: 'foreign-plan' }), { code: 'publication_index_conflict' });
  assert.throws(() => reopened.markIndexed(prior.callRef, { ...prior.indexEntry, userArtifacts: [] }), { code: 'publication_index_conflict' });
  reopened.markIndexed(prior.callRef, prior.indexEntry);
  assert.equal(reopened.getVersion(prior.reference).reference.resultId, prior.reference.resultId);
});

test('cancellation before the transaction commit rolls back objects, head, operation and outbox together', async t => {
  let allowed = true;
  const { store } = fixture(t, { onStep: stage => { if (stage === 'before_commit') allowed = false; } });
  const input = await candidate();
  assert.throws(() => store.commitPublication(input, () => allowed), { code: 'interactive_execution_stale' });
  assert.equal(store.getOperation({ owner, conversationId: source.conversationId, toolCallId: source.toolCallId }), null);
  assert.deepEqual(store.listPending(owner), []);
  const connection = store.storage.connect(owner.workspaceId);
  for (const table of ['objects', 'versions', 'results', 'operations']) assert.equal(connection.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
});

test('same-call retry rejects changed parameters, and stale base revisions cannot silently fork or overwrite', async t => {
  const { store } = fixture(t);
  const first = store.commitPublication(await candidate(), current);
  store.markIndexed(first.callRef, first.indexEntry);
  const changedParameters = { ...await candidate(), draft: { ...draft, title: 'changed' } };
  assert.throws(() => store.commitPublication(changedParameters, current), { code: 'publication_parameter_conflict' });
  const revise = { publication: { kind: 'revise', base: first.reference }, program: '$x=3\nroot=Col([Metric("x",$x*3)])' };
  const secondInput = await candidate('publish-b', revise);
  const second = store.commitPublication(secondInput, current);
  store.markIndexed(second.callRef, second.indexEntry);
  assert.equal(second.reference.resultId, first.reference.resultId);
  assert.notEqual(second.reference.contentVersion, first.reference.contentVersion);
  assert.deepEqual(store.getVersion(second.reference).predecessor, first.reference);
  assert.equal(store.getVersion(first.reference).content.program, draft.program);
  assert.throws(() => store.commitPublication({ ...secondInput, source: { ...source, toolCallId: 'publish-c' }, grant: { grantId: 'g', granted: true, toolCallId: 'publish-c' } }, current), { code: 'version_conflict' });
  assert.deepEqual(store.commitPublication(secondInput, current).reference, second.reference, 'original receipt wins before checking a changed head');
});

test('same-content revision reuses the actual original artifact, while creating another result remains explicit', async t => {
  const { store } = fixture(t);
  const first = store.commitPublication(await candidate(), current); store.markIndexed(first.callRef, first.indexEntry);
  const sameContent = store.commitPublication(await candidate('same-content', { publication: { kind: 'revise', base: first.reference } }), current);
  assert.equal(sameContent.unchanged, true); assert.deepEqual(sameContent.reference, first.reference);
  assert.equal(store.getVersion(first.reference).source.toolCallId, source.toolCallId);
  const independent = store.commitPublication(await candidate('new-result'), current);
  assert.notEqual(independent.reference.resultId, first.reference.resultId);
});

test('scope mismatch, grant mismatch, unknown compatibility and quota failure cannot create a published record', async t => {
  const { store, rootDir } = fixture(t);
  const input = await candidate();
  for (const patch of [{ grant: { ...input.grant, granted: false } }, { grant: { ...input.grant, toolCallId: 'other' } }]) {
    assert.throws(() => store.commitPublication({ ...input, ...patch }, current), { code: 'interactive_publication_authority_invalid' });
  }
  const closed = createInteractiveResultStore({ rootDir: path.join(rootDir, 'protected'), now });
  t.after(() => closed.close());
  assert.throws(() => closed.commitPublication(input, current), { code: 'interactive_compatibility_unavailable' });
  const limited = createInteractiveResultStore({ rootDir: path.join(rootDir, 'limited'), now, assertCompatibility: () => true, maxBytes: 100 });
  t.after(() => limited.close());
  assert.throws(() => limited.commitPublication(input, current), { code: 'interactive_store_limit' });
  assert.deepEqual(limited.listPending(owner), []);
});

test('unknown schema, removed database and tampered immutable bytes remain errors rather than empty stores', async t => {
  const { store, rootDir } = fixture(t);
  const first = store.commitPublication(await candidate(), current); store.markIndexed(first.callRef, first.indexEntry);
  const file = path.join(rootDir, owner.workspaceId, 'interactive-results/store.sqlite');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA user_version=999');
  assert.throws(() => store.getVersion(first.reference), { code: 'interactive_storage_incompatible' });
  db.exec('PRAGMA user_version=5');
  db.prepare("UPDATE objects SET body=replace(body,'Trial','False')").run();
  assert.throws(() => store.getVersion(first.reference), { code: 'interactive_content_corrupt' });
  db.close(); store.close(); rmSync(file);
  const missing = createInteractiveResultStore({ rootDir, now, assertCompatibility: () => true });
  t.after(() => missing.close());
  const retry = await candidate('retry');
  assert.throws(() => missing.commitPublication(retry, current), { code: 'interactive_storage_missing' });
});

test('a symlink replacing a workspace is refused on both fresh reads and cached operations', async t => {
  const { store, rootDir } = fixture(t);
  const first = store.commitPublication(await candidate(), current); store.markIndexed(first.callRef, first.indexEntry);
  const elsewhere = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'peer-interactive-elsewhere-')));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  symlinkSync(elsewhere, path.join(rootDir, 'symlink-bot'));
  assert.throws(() => store.getVersion({ ...first.reference, owner: { ...owner, workspaceId: 'symlink-bot' } }), { code: 'interactive_storage_unavailable' });
});

test('material snapshots retain immutable canonical bytes and reject identity rebinding', async t => {
  const { store } = fixture(t);
  const record = { owner, source: { kind: 'tool-result', conversationId: source.conversationId, toolCallId: 'read-a' }, value: [{ id: 1, cost: 3 }],
    dataLevel: 'D3_private', observedAt: now(), truncated: false, redacted: true, evidenceRefs: ['tool-result://read-a'] };
  const ref = store.recordMaterial(record, current);
  const read = store.readMaterial(owner, ref);
  assert.equal(read.canonical, true); assert.equal(read.dataLevel, 'D3_private'); assert.deepEqual(read.value, record.value);
  assert.throws(() => store.recordMaterial({ ...record, value: [{ id: 1, cost: 99 }] }, current), { code: 'material_identity_conflict' });
  assert.equal(store.readMaterial({ ...owner, conversationId: 'other-parent' }, ref), null);
});
