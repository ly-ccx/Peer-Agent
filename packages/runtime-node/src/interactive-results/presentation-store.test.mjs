import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { validateDraft } from '@peer-agent/interactive-content';
import { createInteractiveResultStore } from './store.mjs';
import { createInteractivePresentationStore } from './presentation-store.mjs';
import { encode } from './storage.mjs';

const owner = { workspaceId: 'bot-a', conversationId: 'parent-a' };
const current = () => true;
async function fixture(t, { publish = true } = {}) {
  const rootDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'interactive-presentation-')));
  let allowed = true, ticks = 0;
  const results = createInteractiveResultStore({ rootDir, assertCompatibility: () => true });
  const presentation = createInteractivePresentationStore({ resultStore: results, assertOwner: actual => allowed && encode(actual) === encode(owner),
    now: () => new Date(Date.UTC(2026, 10, 3, 0, 0, ++ticks)).toISOString() });
  t.after(() => { results.close(); rmSync(rootDir, { recursive: true, force: true }); });
  let reference;
  if (publish) {
    const draft = { publication: { kind: 'create' }, title: 'Saved trial', textFallback: 'Unverified model trial.', inputs: [], program: '$x=2\nroot=Col([Metric("Cost",$x*3)])' };
    const receipt = results.commitPublication({ owner, source: { conversationId: 'worker-a', planId: 'plan-a', sessionId: 'session-a', toolCallId: 'publish-a', executionEpoch: 'epoch-a' },
      draft, content: await validateDraft(draft), provenance: [], dataLevel: 'D3_private', grant: { toolCallId: 'publish-a', grantId: 'grant-a', granted: true } }, current);
    results.markIndexed(receipt.callRef, receipt.indexEntry); reference = receipt.reference;
  }
  const resource = { kind: 'interactive', reference }, context = { owner, resource, sourceTabId: 'tab-a', navigation: { top: 120, left: 0 } };
  return { results, presentation, resource, context, rootDir, revoke: () => { allowed = false; } };
}

test('dormant presentation reads do not create a domain and ordinary layout writes cannot activate it', async t => {
  const f = await fixture(t, { publish: false });
  assert.equal(f.presentation.readLayout(owner), null);
  assert.deepEqual(f.presentation.history.list(owner), { ok: true, status: 'ok', entries: [] });
  assert.throws(() => f.presentation.writeLayout(owner, { expectedRevision: 0, order: ['launcher'], recent: [] }), { code: 'interactive_presentation_unavailable' });
  assert.equal(existsSync(path.join(f.rootDir, owner.workspaceId)), false);
});

test('history retains fixed identity/title and only eight readings; removing a reading preserves the result', async t => {
  const f = await fixture(t), scope = { owner, resource: f.resource };
  for (let i = 0; i < 10; i++) f.presentation.history.save({ ...f.context, title: 'forged title', navigation: { top: i, left: 0 } }, scope, `reading-${i}`);
  const before = f.presentation.history.list(owner);
  assert.equal(before.ok, true); assert.equal(before.entries.length, 8);
  assert.equal(before.entries[0].id, 'reading-9'); assert.equal(before.entries[0].title, 'Saved trial');
  assert.equal(before.entries[0].sourceBinding, undefined);
  assert.equal(before.entries[0].request.resource.reference.path, undefined);
  assert.equal(before.entries[0].request.resource.reference.owner.conversationId, owner.conversationId);
  assert.equal(f.presentation.history.remove('reading-9', owner), true);
  assert.equal(f.presentation.history.find('reading-9', owner), null);
  assert.equal(f.results.getVersion(f.resource.reference).content.title, 'Saved trial');
  f.revoke(); assert.equal(f.presentation.history.list(owner).status, 'scope_denied');
  assert.throws(() => f.presentation.history.save(f.context, scope), { code: 'interactive_scope_denied' });
});

test('history rejects forged owner/source and corrupt metadata without replacing it with an empty history', async t => {
  const f = await fixture(t), history = f.presentation.history;
  const id = history.save(f.context, { owner, resource: f.resource });
  assert.throws(() => history.save({ ...f.context, owner: { ...owner, conversationId: 'other' } }, { owner, resource: f.resource }), { code: 'interactive_scope_denied' });
  assert.throws(() => history.save(f.context, { owner, resource: { kind: 'interactive', reference: { ...f.resource.reference, contentVersion: 'sha256:' + 'a'.repeat(64) } } }), { code: 'interactive_scope_denied' });
  const db = f.results.storage.connect(owner.workspaceId, true).db;
  db.prepare('UPDATE presentation SET body=? WHERE id=?').run('{"unknown":true}', id);
  const before = db.prepare('SELECT body FROM presentation WHERE id=?').get(id).body;
  assert.equal(history.list(owner).ok, false);
  assert.throws(() => history.save(f.context, { owner, resource: f.resource }), { code: 'interactive_presentation_corrupt' });
  assert.equal(db.prepare('SELECT body FROM presentation WHERE id=?').get(id).body, before);
});

test('mixed layout has independent durable CAS and refuses corruption, over-budget keys and owner changes', async t => {
  const f = await fixture(t), input = { expectedRevision: 0, order: ['document:a', 'interactive:fixed-a'], recent: ['interactive:fixed-a'] };
  const first = f.presentation.writeLayout(owner, input);
  assert.equal(first.revision, 1); assert.deepEqual(f.presentation.readLayout(owner), first);
  assert.throws(() => f.presentation.writeLayout(owner, input), { code: 'interactive_layout_conflict' });
  assert.throws(() => f.presentation.writeLayout(owner, { ...input, expectedRevision: 1, order: ['permission:full'] }), { code: 'interactive_layout_invalid' });
  assert.throws(() => f.presentation.writeLayout(owner, { ...input, expectedRevision: 1, order: ['interactive:a', 'interactive:a'] }), { code: 'interactive_layout_invalid' });
  const second = f.presentation.writeLayout(owner, { ...input, expectedRevision: 1, order: [...input.order].reverse() });
  assert.equal(second.revision, 2); assert.deepEqual(second.order, ['interactive:fixed-a', 'document:a']);
  const reopened = createInteractiveResultStore({ rootDir: f.rootDir, assertCompatibility: () => true });
  try { assert.deepEqual(createInteractivePresentationStore({ resultStore: reopened, assertOwner: current }).readLayout(owner), second); }
  finally { reopened.close(); }
  const db = f.results.storage.connect(owner.workspaceId, true).db;
  db.prepare("UPDATE presentation SET body=? WHERE category='mixed-resource-layout'").run(encode({ ...second, revision: '3' }));
  assert.throws(() => f.presentation.readLayout(owner), { code: 'interactive_presentation_corrupt' });
  assert.throws(() => f.presentation.writeLayout(owner, { ...input, expectedRevision: 2 }), { code: 'interactive_presentation_corrupt' });
  f.revoke(); assert.throws(() => f.presentation.readLayout(owner), { code: 'interactive_scope_denied' });
});

test('a cached writer checks the subdomain version again before presentation writes', async t => {
  const f = await fixture(t), db = f.results.storage.connect(owner.workspaceId, true).db;
  db.exec('PRAGMA user_version=4');
  assert.throws(() => f.presentation.writeLayout(owner, { expectedRevision: 0, order: ['interactive:a'], recent: [] }), { code: 'interactive_storage_incompatible' });
  assert.equal(f.presentation.history.list(owner).ok, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM presentation').get().n, 0);
  db.exec('PRAGMA user_version=5');
});
