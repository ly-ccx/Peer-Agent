import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateDraft } from '@peer-agent/interactive-content';
import { createInteractiveResultStore } from './store.mjs';
import { createInteractiveStateStore } from './state-store.mjs';

const owner = { workspaceId: 'bot-a', conversationId: 'parent-a' };
const now = () => '2026-11-03T00:00:00.000Z';
const identity = { viewId: 'view-a', windowId: 'window-a', generation: 'generation-a' };
const current = () => true;
async function fixture(t) {
  const rootDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'peer-interactive-state-'))), resources = [];
  const reopen = () => {
    const resultStore = createInteractiveResultStore({ rootDir, now, assertCompatibility: () => true });
    const states = createInteractiveStateStore({ resultStore, now }); resources.push({ resultStore, states });
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
  const frozen = states.prepareFollowup(request, current);
  save(1, 'save-b', 900);
  assert.equal(states.read(reference, current).values.$budget, 900);
  assert.equal(states.readFollowup(owner, frozen.followupId).values.$budget, 250);
  assert.deepEqual(states.prepareFollowup(request, current), frozen);
  assert.equal(frozen.dataLevel, 'D3_private');
  assert.throws(() => states.prepareFollowup({ ...request, fields: [] }, current), { code: 'interactive_followup_parameter_conflict' });
});

test('old/unconfirmed revisions and incomplete numeric drafts cannot silently prepare earlier values', async t => {
  const { states, reference, writer, save } = await fixture(t);
  const saved = save(0, 'save-a', 250, { $budget: '-' });
  const request = { reference, identity, writer, stateRevision: saved.stateRevision, stateDigest: saved.stateDigest, fields: ['$budget'], requestId: 'followup-a' };
  assert.throws(() => states.prepareFollowup(request, current), { code: 'followup_input_incomplete' });
  const currentState = save(1, 'save-b', 300);
  assert.throws(() => states.prepareFollowup(request, current), { code: 'state_revision_unavailable' });
  const frozen = states.prepareFollowup({ ...request, stateRevision: currentState.stateRevision, stateDigest: currentState.stateDigest }, current);
  assert.equal(frozen.values.$budget, 300);
});

test('foreign views, values, versions and invalid range writes preserve the last confirmed state', async t => {
  const { states, reference, writer, save } = await fixture(t);
  save(0, 'save-a', 150);
  assert.throws(() => states.read(reference, () => false), { code: 'interactive_view_stale' });
  assert.throws(() => save(1, 'save-b', 200, {}, { identity: { ...identity, windowId: 'other-window' } }), { code: 'interactive_writer_stale' });
  assert.throws(() => save(1, 'save-c', 1001), { code: 'invalid_state' });
  assert.throws(() => save(1, 'save-d', 200, {}, { values: { $budget: 200, $permission: true } }), { code: 'invalid_state' });
  assert.throws(() => states.prepareFollowup({ reference, identity, writer, stateRevision: 1, stateDigest: 'forged', fields: ['$budget'], requestId: 'followup-a' }, current), { code: 'state_revision_unavailable' });
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
