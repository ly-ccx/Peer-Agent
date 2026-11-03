import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateDraft } from '@peer-agent/interactive-content';
import { createInteractiveResultStore } from './store.mjs';
import { createInteractiveStateStore } from './state-store.mjs';
import { runInteractiveValidation } from './validation.mjs';
import { jsonDigest } from './storage.mjs';

const owner = { workspaceId: 'bot-a', conversationId: 'parent-a' };
const now = () => '2026-11-03T00:00:00.000Z';
const identity = { viewId: 'view-a', windowId: 'window-a', generation: 'generation-a' };
const current = () => true;
async function fixture(t, stateOptions = {}) {
  const rootDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'peer-interactive-state-'))), resources = [];
  const reopen = () => {
    const resultStore = createInteractiveResultStore({ rootDir, now, assertCompatibility: () => true });
    const states = createInteractiveStateStore({ resultStore, now, ...stateOptions }); resources.push({ resultStore, states });
    return { resultStore, states };
  };
  t.after(() => { for (const item of resources) { item.states.close(); item.resultStore.close(); } rmSync(rootDir, { recursive: true, force: true }); });
  const first = reopen();
  const draft = { publication: { kind: 'create' }, title: 'Budget', textFallback: 'Model trial',
    program: '$budget=100\nroot=Col([NumberInput("budget","Budget",$budget,0,1000,1),Metric("Double",$budget*2)])', inputs: [] };
  const source = { conversationId: 'worker-a', planId: 'plan-a', sessionId: 'session-a', executionEpoch: 'epoch-a', toolCallId: 'publish-a' };
  const receipt = first.resultStore.commitPublication({ owner, source, draft, content: await validateDraft(draft), provenance: [], dataLevel: 'D3_private',
    grant: { grantId: 'grant-a', granted: true, toolCallId: source.toolCallId } }, current);
  first.resultStore.markIndexed(receipt.callRef, receipt.indexEntry);
  const reference = receipt.reference;
  const writer = first.states.acquire({ reference, identity, expectedRevision: 0 }, current);
  const save = (revision, requestId, value, inputDrafts = {}, overrides = {}) => first.states.save({ reference, identity, writer, expectedRevision: revision,
    requestId, values: { $budget: value }, inputDrafts, ...overrides }, current);
  return { ...first, rootDir, reopen, reference, writer, save, receipt };
}

test('confirmed state revisions and raw numeric drafts survive reads; a retry returns the original receipt only', async t => {
  const { states, reference, save } = await fixture(t);
  const saved = save(0, 'save-a', 150, { $budget: '150.' });
  assert.equal(saved.stateRevision, 1); assert.equal(saved.inputDrafts.$budget, '150.');
  assert.deepEqual(states.read(reference, current), saved);
  assert.deepEqual(save(0, 'save-a', 150, { $budget: '150.' }), saved);
  assert.equal(states.read(reference, current).stateRevision, 1);
  assert.throws(() => save(0, 'save-a', 200), { code: 'interactive_save_parameter_conflict' });
  assert.throws(() => save(0, 'save-b', 200), { code: 'interactive_state_conflict' });
  assert.equal(states.read(reference, current).values.$budget, 150);
});

test('direct host save refuses protected drafts before writing state or save receipts and permits correction', async t => {
  const { states, resultStore, reference, save } = await fixture(t);
  const confirmed = save(0, 'safe-a', 150, { $budget: '150.' });
  const context = resultStore.storage.connect(owner.workspaceId);
  const beforeSaves = context.db.prepare('SELECT COUNT(*) AS n FROM saves').get().n;
  for (const raw of ['sk-examplecredential012345678901234567890', JSON.stringify({ grantId: 'example', toolCallId: 'call', granted: true })]) {
    assert.throws(() => save(1, 'protected-a', 150, { $budget: raw }), error => error.code === 'interactive_state_protected'
      && error.message === 'interactive_state_protected' && error.details === '');
    assert.deepEqual(states.read(reference, current), confirmed);
    assert.equal(context.db.prepare('SELECT COUNT(*) AS n FROM saves').get().n, beforeSaves);
    assert.equal(context.db.prepare('SELECT COUNT(*) AS n FROM followups').get().n, 0);
  }
  assert.equal(save(1, 'protected-a', 160, { $budget: '160' }).stateRevision, 2);
});

test('an old protected checkpoint cannot be read, overwritten or frozen, and its original row remains intact', async t => {
  const { states, resultStore, reference, writer, save } = await fixture(t);
  const saved = save(0, 'safe-a', 150);
  const old = { ...saved, inputDrafts: { $budget: 'Bearer synthetic-old-token' } };
  old.stateDigest = jsonDigest({ values: old.values, inputDrafts: old.inputDrafts });
  const context = resultStore.storage.connect(owner.workspaceId), original = JSON.stringify(old);
  context.db.prepare('UPDATE states SET snapshot=? WHERE id=? AND version=?').run(original, reference.resultId, reference.contentVersion);
  assert.throws(() => states.read(reference, current), { code: 'interactive_state_protected' });
  assert.throws(() => save(1, 'next', 160), { code: 'interactive_state_protected' });
  await assert.rejects(states.prepareFollowup({ reference, identity, writer, stateRevision: old.stateRevision, stateDigest: old.stateDigest,
    fields: ['$budget'], requestId: 'protected-freeze' }, current), { code: 'interactive_state_protected' });
  assert.equal(context.db.prepare('SELECT snapshot FROM states WHERE id=? AND version=?').get(reference.resultId, reference.contentVersion).snapshot, original);
  assert.equal(context.db.prepare('SELECT COUNT(*) AS n FROM followups').get().n, 0);
});

test('two independent store instances share one writer; explicit takeover rejects the old token and late save', async t => {
  const { states, reference, save, reopen } = await fixture(t);
  save(0, 'save-a', 150);
  const other = reopen(), view = { viewId: 'view-b', windowId: 'window-b', generation: 'generation-b' };
  assert.throws(() => other.states.acquire({ reference, identity: view, expectedRevision: 1 }, current), { code: 'interactive_writer_busy' });
  const writer = other.states.acquire({ reference, identity: view, expectedRevision: 1, takeover: true }, current);
  assert.throws(() => save(1, 'late-save', 999), { code: 'interactive_writer_stale' });
  other.states.save({ reference, identity: view, writer, expectedRevision: 1, requestId: 'save-b', values: { $budget: 200 }, inputDrafts: {} }, current);
  assert.equal(states.read(reference, current).values.$budget, 200);
});

test('a lost save acknowledgment resolves its original immutable receipt after takeover without writing or reclaiming the writer', async t => {
  const f = await fixture(t), saved = f.save(0, 'save-a', 150, { $budget: '150' });
  const other = f.reopen(), next = { viewId: 'view-b', windowId: 'window-b', generation: 'generation-b' };
  const writer = other.states.acquire({ reference: f.reference, identity: next, expectedRevision: 1, takeover: true }, current);
  other.states.save({ reference: f.reference, identity: next, writer, expectedRevision: 1, requestId: 'save-b', values: { $budget: 200 }, inputDrafts: {} }, current);
  const original = { reference: f.reference, identity, writer: f.writer, expectedRevision: 0, requestId: 'save-a', values: { $budget: 150 }, inputDrafts: { $budget: '150' } };
  assert.deepEqual(f.states.saveOutcome(original, current), { state: saved, writerCurrent: false });
  assert.deepEqual(f.states.save(original, current), saved);
  assert.equal(f.states.read(f.reference, current).values.$budget, 200);
  assert.throws(() => f.states.saveOutcome({ ...original, requestId: 'never-committed' }, current), { code: 'interactive_writer_stale', saveStatus: 'not_committed' });
  assert.throws(() => f.states.saveOutcome({ ...original, values: { $budget: 300 } }, current), { code: 'interactive_save_parameter_conflict' });
  assert.throws(() => f.states.saveOutcome(original, () => false), { code: 'interactive_view_stale' });
  const count = f.resultStore.storage.connect(owner.workspaceId).db.prepare('SELECT COUNT(*) AS count FROM saves').get().count;
  assert.equal(Number(count), 2);
});

test('only a past CAS base proves an absent save cannot commit; corrupt historical receipts remain unresolved', async t => {
  const f = await fixture(t), saved = f.save(0, 'save-a', 150);
  const original = { reference: f.reference, identity, writer: f.writer, expectedRevision: 0, requestId: 'save-a', values: { $budget: 150 }, inputDrafts: {} };
  assert.throws(() => f.states.saveOutcome({ ...original, requestId: 'absent' }, current), { code: 'interactive_state_conflict', saveStatus: 'not_committed' });
  assert.throws(() => f.states.saveOutcome({ ...original, requestId: 'future', expectedRevision: 5 }, current), error => error.code === 'interactive_state_conflict' && error.saveStatus === undefined);
  const db = f.resultStore.storage.connect(owner.workspaceId).db;
  db.prepare('UPDATE saves SET receipt=? WHERE requestId=?').run(JSON.stringify({ ...saved, requestId: 'wrong' }), 'save-a');
  assert.throws(() => f.states.saveOutcome(original, current), { code: 'interactive_save_receipt_corrupt' });
  db.prepare('UPDATE saves SET receipt=? WHERE requestId=?').run(JSON.stringify({ ...saved, values: { $budget: 999 } }), 'save-a');
  assert.throws(() => f.states.saveOutcome(original, current), { code: 'interactive_state_corrupt' });
  assert.equal(f.states.read(f.reference, current).values.$budget, 150);
});

test('normal shutdown releases only its own writer and restoration preserves values without creating publication facts', async t => {
  const { states, resultStore, reference, save, reopen } = await fixture(t);
  save(0, 'save-a', 175, { $budget: '-' });
  const operations = resultStore.storage.connect(owner.workspaceId).db.prepare('SELECT COUNT(*) AS count FROM operations').get().count;
  states.close();
  const restored = reopen();
  const state = restored.states.read(reference, current);
  assert.equal(state.values.$budget, 175); assert.equal(state.inputDrafts.$budget, '-');
  const writer = restored.states.acquire({ reference, identity: { ...identity, generation: 'new-generation' }, expectedRevision: 1 }, current);
  assert.ok(writer.token);
  assert.equal(resultStore.storage.connect(owner.workspaceId).db.prepare('SELECT COUNT(*) AS count FROM operations').get().count, operations);
});

test('followup values are immutable and self-contained after later edits; same request is idempotent', async t => {
  const { states, reference, writer, save } = await fixture(t);
  const saved = save(0, 'save-a', 250);
  const request = { reference, identity, writer, stateRevision: saved.stateRevision, stateDigest: saved.stateDigest, fields: ['$budget'], requestId: 'followup-a' };
  const frozen = await states.prepareFollowup(request, current);
  save(1, 'save-b', 900);
  assert.equal(states.read(reference, current).values.$budget, 900);
  assert.equal(states.readFollowup(owner, frozen.followupId).values.$budget, 250);
  assert.deepEqual(await states.prepareFollowup(request, current), frozen);
  assert.equal(frozen.dataLevel, 'D3_private');
  await assert.rejects(() => states.prepareFollowup({ ...request, fields: ['$different'] }, current), { code: 'interactive_followup_parameter_conflict' });
  await assert.rejects(() => states.prepareFollowup({ ...request, fields: [] }, current), { code: 'interactive_followup_invalid' });
});

test('condition labels are rebuilt from persisted content after reopening, without a stored or renderer tree', async t => {
  const f = await fixture(t); f.states.close();
  const next = f.reopen(), identity2 = { ...identity, generation: 'restored-view' };
  assert.equal(next.resultStore.getVersion(f.reference).content.tree, undefined);
  const writer = next.states.acquire({ reference: f.reference, identity: identity2, expectedRevision: 0 }, current);
  const saved = next.states.save({ reference: f.reference, identity: identity2, writer, expectedRevision: 0, requestId: 'restored-save', values: { $budget: 250 }, inputDrafts: {} }, current);
  const frozen = await next.states.prepareFollowup({ reference: f.reference, identity: identity2, writer, stateRevision: saved.stateRevision,
    stateDigest: saved.stateDigest, fields: ['$budget'], requestId: 'restored-freeze' }, current);
  assert.equal(frozen.excerpt, 'Budget\nBudget: 250');
  assert.equal(next.resultStore.getVersion(f.reference).content.tree, undefined, 'projection does not rewrite canonical content');
});

for (const change of ['state', 'writer', 'owner', 'abort']) test(`asynchronous condition projection rechecks ${change} and holds no storage transaction while waiting`, async t => {
  let entered, release, allowed = true;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { describeConditions: async (input, options) => {
    const description = await runInteractiveValidation({ operation: 'describe-state', ...input }, options); entered(); await gate; return description;
  } });
  const saved = f.save(0, 'save-a', 250), controller = new AbortController();
  const pending = f.states.prepareFollowup({ reference: f.reference, identity, writer: f.writer, stateRevision: saved.stateRevision,
    stateDigest: saved.stateDigest, fields: ['$budget'], requestId: 'racing-freeze' }, () => allowed, { signal: controller.signal });
  await started;
  if (change === 'state') f.save(1, 'save-b', 300);
  if (change === 'writer') {
    const other = f.reopen(); other.states.acquire({ reference: f.reference, identity: { ...identity, viewId: 'other' }, expectedRevision: 1, takeover: true }, current);
  }
  if (change === 'owner') allowed = false;
  if (change === 'abort') controller.abort();
  release();
  await assert.rejects(pending, { code: ({ state: 'state_revision_unavailable', writer: 'interactive_writer_stale', owner: 'interactive_view_stale', abort: 'interactive_view_stale' })[change] });
  assert.throws(() => f.states.readFollowup(owner, 'racing-freeze'), { code: 'interactive_followup_unavailable' });
});

test('unconfirmed condition text cannot create a frozen record, and an existing canonical freeze does not rebuild labels', async t => {
  let fail = false, calls = 0;
  const f = await fixture(t, { describeConditions: async (input, options) => {
    calls++; if (fail) return { text: 'Forged labels', specHash: 'wrong', stateSchemaHash: 'wrong' };
    return runInteractiveValidation({ operation: 'describe-state', ...input }, options);
  } });
  const saved = f.save(0, 'save-a', 250), request = { reference: f.reference, identity, writer: f.writer, stateRevision: saved.stateRevision,
    stateDigest: saved.stateDigest, fields: ['$budget'], requestId: 'canonical-freeze' };
  const frozen = await f.states.prepareFollowup(request, current); assert.equal(calls, 1);
  fail = true;
  assert.deepEqual(await f.states.prepareFollowup(request, current), frozen); assert.equal(calls, 1);
  await assert.rejects(f.states.prepareFollowup({ ...request, requestId: 'wrong-label-freeze' }, current), { code: 'interactive_condition_labels_unavailable' });
  assert.throws(() => f.states.readFollowup(owner, 'wrong-label-freeze'), { code: 'interactive_followup_unavailable' });
});

test('old/unconfirmed revisions and incomplete numeric drafts cannot silently prepare earlier values', async t => {
  const { states, reference, writer, save } = await fixture(t);
  const saved = save(0, 'save-a', 250, { $budget: '-' });
  const request = { reference, identity, writer, stateRevision: saved.stateRevision, stateDigest: saved.stateDigest, fields: ['$budget'], requestId: 'followup-a' };
  await assert.rejects(() => states.prepareFollowup(request, current), { code: 'followup_input_incomplete' });
  const currentState = save(1, 'save-b', 300);
  await assert.rejects(() => states.prepareFollowup(request, current), { code: 'state_revision_unavailable' });
  const frozen = await states.prepareFollowup({ ...request, stateRevision: currentState.stateRevision, stateDigest: currentState.stateDigest }, current);
  assert.equal(frozen.values.$budget, 300);
});

test('new frozen conditions inherit a later owner privacy floor while prior frozen conditions remain immutable', async t => {
  const { states, resultStore, reference, writer, save } = await fixture(t);
  const saved = save(0, 'save-a', 250);
  const request = { reference, identity, writer, stateRevision: saved.stateRevision, stateDigest: saved.stateDigest, fields: ['$budget'], requestId: 'followup-before' };
  const before = await states.prepareFollowup(request, current);
  resultStore.rememberObservationLevel(owner, 'D4_regulated', current);
  const after = await states.prepareFollowup({ ...request, requestId: 'followup-after' }, current);
  assert.equal(before.dataLevel, 'D3_private');
  assert.equal(after.dataLevel, 'D4_regulated');
  assert.deepEqual(states.readFollowup(owner, before.followupId), before);
});

test('foreign views, values, versions and invalid range writes preserve the last confirmed state', async t => {
  const { states, reference, writer, save } = await fixture(t);
  save(0, 'save-a', 150);
  assert.throws(() => states.read(reference, () => false), { code: 'interactive_view_stale' });
  assert.throws(() => save(1, 'save-b', 200, {}, { identity: { ...identity, windowId: 'other-window' } }), { code: 'interactive_writer_stale' });
  assert.throws(() => save(1, 'save-c', 1001), { code: 'invalid_state' });
  assert.throws(() => save(1, 'save-d', 200, {}, { values: { $budget: 200, $permission: true } }), { code: 'invalid_state' });
  await assert.rejects(() => states.prepareFollowup({ reference, identity, writer, stateRevision: 1, stateDigest: 'forged', fields: ['$budget'], requestId: 'followup-a' }, current), { code: 'state_revision_unavailable' });
  assert.throws(() => states.readFollowup({ ...owner, conversationId: 'other' }, 'followup-a'), { code: 'interactive_followup_unavailable' });
  assert.equal(states.read(reference, current).values.$budget, 150);
});

test('state tampering is detected rather than repaired into defaults', async t => {
  const { states, reference, resultStore, save } = await fixture(t);
  save(0, 'save-a', 150);
  const db = resultStore.storage.connect(owner.workspaceId).db;
  db.prepare("UPDATE states SET snapshot=replace(snapshot,'150','900')").run();
  assert.throws(() => states.read(reference, current), { code: 'interactive_state_corrupt' });
});

test('frozen condition tampering cannot change the values delivered under the original followup identity', async t => {
  const { states, reference, writer, resultStore, save } = await fixture(t);
  const saved = save(0, 'save-a', 250);
  await states.prepareFollowup({ reference, identity, writer, stateRevision: 1, stateDigest: saved.stateDigest, fields: ['$budget'], requestId: 'followup-a' }, current);
  resultStore.storage.connect(owner.workspaceId).db.prepare(`UPDATE followups SET snapshot=replace(snapshot,'"$budget":250','"$budget":999')`).run();
  assert.throws(() => states.readFollowup(owner, 'followup-a'), { code: 'interactive_followup_corrupt' });
});
