import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { validateDraft } from '@peer-agent/interactive-content';
import { createInteractiveResultStore } from './store.mjs';
import { createInteractiveStateStore } from './state-store.mjs';
import { createInteractiveViewService } from './view-service.mjs';
import { runInteractiveValidation } from './validation.mjs';

const owner = { workspaceId: 'bot-a', conversationId: 'parent-a' };
const current = () => true;
function sender() { const value = new EventEmitter(); value.isDestroyed = () => value.destroyed === true; return value; }
async function fixture(t, options = {}) {
  const { stateOptions, ...viewOptions } = options;
  const rootDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'interactive-views-')));
  const results = createInteractiveResultStore({ rootDir, assertCompatibility: () => true });
  const states = createInteractiveStateStore({ resultStore: results, ...stateOptions });
  const draft = { publication: { kind: 'create' }, title: 'Trial', textFallback: 'Model trial, unverified.', inputs: [],
    program: '$budget=100\nroot=Col([NumberInput("budget","Budget",$budget,0,1000,1),Metric("Cost",$budget*2)])' };
  const receipt = results.commitPublication({ owner, source: { conversationId: 'worker-a', planId: 'plan-a', sessionId: 'session-a', toolCallId: 'publish-a', executionEpoch: 'epoch-a' },
    draft, content: await validateDraft(draft), provenance: [], dataLevel: 'D3_private', grant: { toolCallId: 'publish-a', grantId: 'grant-a', granted: true } }, current);
  results.markIndexed(receipt.callRef, receipt.indexEntry);
  const a = sender(), b = sender();
  let allowed = true, admissions = 0;
  const service = createInteractiveViewService({ resultStore: results, stateStore: states,
    resolveSource: (actual, ref) => { admissions++; return allowed && [a, b].includes(actual) && JSON.stringify(ref.owner) === JSON.stringify(owner)
      ? { owner, assertCurrent: () => allowed && !actual.isDestroyed() } : null; }, ...viewOptions });
  t.after(() => { service.dispose(); states.close(); results.close(); rmSync(rootDir, { recursive: true, force: true }); });
  const open = (actual = a, requestId = 'open-a', reference = receipt.reference) => service.open(actual, { requestId, reference });
  return { results, states, service, a, b, receipt, open, admissionCount: () => admissions, revoke: () => { allowed = false; } };
}

test('human view service binds the actual sender and immutable version, saves state and freezes conditions without new publication facts', async t => {
  const f = await fixture(t), opened = await f.open();
  assert.equal(opened.ok, true);
  assert.deepEqual(opened.result.reference, f.receipt.reference);
  assert.equal(opened.result.operationId, undefined);
  assert.equal(opened.result.grantAudit, undefined);
  const repeated = await f.open(); assert.deepEqual(repeated.handle, opened.handle); assert.equal(f.admissionCount(), 1);
  const acquired = f.service.acquire(f.a, { handle: opened.handle, expectedRevision: 0 });
  assert.equal(acquired.ok, true);
  const save = { handle: opened.handle, writer: acquired.writer, expectedRevision: 0, requestId: 'save-a', values: { $budget: 200 }, inputDrafts: { $budget: '200' } };
  const saved = f.service.save(f.a, save);
  assert.equal(saved.ok, true); assert.equal(saved.state.stateRevision, 1);
  assert.deepEqual(f.service.save(f.a, save), saved);
  const frozen = await f.service.prepareFollowup(f.a, { handle: opened.handle, stateRevision: 1, stateDigest: saved.state.stateDigest, fields: ['$budget'], requestId: 'followup-a' });
  assert.equal(frozen.ok, true); assert.equal(frozen.followup.values.$budget, 200);
  assert.equal(f.service.readState(f.b, { handle: opened.handle }).code, 'interactive_view_stale');
  assert.equal(f.service.save(f.b, save).code, 'interactive_view_stale');
  assert.equal(f.service.readState(f.a, { handle: opened.handle, reference: { ...f.receipt.reference, resultId: 'other' } }).code, 'interactive_request_invalid');
  assert.equal(f.service.readState(f.a, { handle: { ...opened.handle, windowId: 'other-window' } }).code, 'interactive_view_stale');
  assert.equal((await f.open(f.a, 'open-a', { ...f.receipt.reference, resultId: 'other' })).code, 'interactive_open_parameter_conflict');
  const counts = f.results.storage.connect(owner.workspaceId).db.prepare('SELECT (SELECT COUNT(*) FROM versions) AS versions,(SELECT COUNT(*) FROM operations) AS operations').get();
  assert.equal(Number(counts.versions), 1); assert.equal(Number(counts.operations), 1);
});

test('the actual sender can settle only its exact old save after takeover, including after acquiring a new writer', async t => {
  const f = await fixture(t), a = await f.open(), b = await f.open(f.b, 'open-b');
  const writerA = f.service.acquire(f.a, { handle: a.handle, expectedRevision: 0 }).writer;
  const request = { handle: a.handle, writer: writerA, expectedRevision: 0, requestId: 'save-a', values: { $budget: 150 }, inputDrafts: {} };
  const first = f.service.save(f.a, request);
  assert.equal(first.writerCurrent, true);
  const writerB = f.service.acquire(f.b, { handle: b.handle, expectedRevision: 1, takeover: true }).writer;
  f.service.save(f.b, { handle: b.handle, writer: writerB, expectedRevision: 1, requestId: 'save-b', values: { $budget: 200 }, inputDrafts: {} });
  assert.deepEqual(f.service.save(f.a, request), { ok: true, state: first.state, writerCurrent: false });
  assert.equal(f.service.save(f.b, request).code, 'interactive_view_stale');
  assert.deepEqual(f.service.save(f.a, { ...request, requestId: 'absent' }), { ok: false, code: 'interactive_writer_stale', saveStatus: 'not_committed' });
  const next = f.service.acquire(f.a, { handle: a.handle, expectedRevision: 2, takeover: true }); assert.equal(next.ok, true);
  assert.equal(f.service.save(f.a, request).writerCurrent, false);
  assert.equal(f.service.readState(f.a, { handle: a.handle }).state.values.$budget, 200);
});

test('a view shares duplicate frozen requests and bounds other concurrent requests before starting another projection', async t => {
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { stateOptions: { describeConditions: async (input, options) => {
    calls++; await gate; return runInteractiveValidation({ operation: 'describe-state', ...input }, options);
  } } }), opened = await f.open();
  const writer = f.service.acquire(f.a, { handle: opened.handle, expectedRevision: 0 }).writer;
  const saved = f.service.save(f.a, { handle: opened.handle, writer, expectedRevision: 0, requestId: 'save', values: { $budget: 200 }, inputDrafts: {} });
  const request = { handle: opened.handle, stateRevision: saved.state.stateRevision, stateDigest: saved.state.stateDigest, fields: ['$budget'], requestId: 'freeze' };
  const first = f.service.prepareFollowup(f.a, request), second = f.service.prepareFollowup(f.a, structuredClone(request));
  assert.equal((await f.service.prepareFollowup(f.a, { ...request, requestId: 'different' })).code, 'interactive_followup_busy');
  assert.equal(calls, 1); release();
  const [a, b] = await Promise.all([first, second]); assert.deepEqual(a, b); assert.equal(a.ok, true);
  assert.equal(a.followup.excerpt, 'Trial\nBudget: 200');
});

test('retiring the actual view aborts its condition projection and cannot leave a frozen record', async t => {
  let aborted = 0;
  const f = await fixture(t, { stateOptions: { describeConditions: (_input, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted++; reject(Object.assign(Error('cancelled'), { code: 'interactive_cancelled' })); }, { once: true });
  }) } }), opened = await f.open();
  const writer = f.service.acquire(f.a, { handle: opened.handle, expectedRevision: 0 }).writer;
  const saved = f.service.save(f.a, { handle: opened.handle, writer, expectedRevision: 0, requestId: 'save', values: { $budget: 200 }, inputDrafts: {} });
  const pending = f.service.prepareFollowup(f.a, { handle: opened.handle, stateRevision: saved.state.stateRevision, stateDigest: saved.state.stateDigest, fields: ['$budget'], requestId: 'freeze' });
  f.service.closeSender(f.a);
  assert.equal((await pending).code, 'interactive_cancelled'); assert.equal(aborted, 1);
  assert.throws(() => f.states.readFollowup(owner, 'freeze'), { code: 'interactive_followup_unavailable' });
});

test('a second view needs explicit takeover; old saves and old releases cannot overwrite or release the successor', async t => {
  const f = await fixture(t), a = await f.open(), b = await f.open(f.b, 'open-b');
  const writer = f.service.acquire(f.a, { handle: a.handle, expectedRevision: 0 }).writer;
  assert.equal(f.service.acquire(f.b, { handle: b.handle, expectedRevision: 0 }).code, 'interactive_writer_busy');
  assert.equal((await f.service.prepareFollowup(f.b, { handle: b.handle, stateRevision: 0, stateDigest: a.state.stateDigest, fields: [], requestId: 'followup-b' })).code, 'interactive_writer_required');
  const successor = f.service.acquire(f.b, { handle: b.handle, expectedRevision: 0, takeover: true }).writer;
  assert.equal(f.service.save(f.a, { handle: a.handle, writer, expectedRevision: 0, requestId: 'late-save', values: { $budget: 999 }, inputDrafts: {} }).code, 'interactive_writer_stale');
  assert.equal(f.service.release(f.a, { handle: a.handle, writer }).ok, true);
  assert.equal(f.service.release(f.a, { handle: a.handle, writer }).ok, true, 'a lost close acknowledgment is idempotent');
  assert.equal(f.service.release(f.b, { handle: a.handle, writer }).code, 'interactive_view_stale');
  assert.equal(f.service.save(f.b, { handle: b.handle, writer: successor, expectedRevision: 0, requestId: 'save-b', values: { $budget: 250 }, inputDrafts: {} }).ok, true);
  assert.equal(f.service.readState(f.a, { handle: a.handle }).code, 'interactive_view_stale');
});

test('owner revocation blocks reads and saves; real sender destruction releases only its writer', async t => {
  const f = await fixture(t), a = await f.open(), b = await f.open(f.b, 'open-b');
  f.service.acquire(f.a, { handle: a.handle, expectedRevision: 0 });
  f.a.destroyed = true; f.a.emit('destroyed');
  assert.equal(f.service.readState(f.a, { handle: a.handle }).code, 'interactive_view_stale');
  const writer = f.service.acquire(f.b, { handle: b.handle, expectedRevision: 0 }).writer;
  assert.ok(writer);
  f.revoke();
  assert.equal(f.service.readState(f.b, { handle: b.handle }).code, 'interactive_view_stale');
  assert.equal(f.service.save(f.b, { handle: b.handle, writer, expectedRevision: 0, requestId: 'revoked', values: { $budget: 900 }, inputDrafts: {} }).code, 'interactive_view_stale');
  assert.equal(f.states.read(f.receipt.reference, current).stateRevision, 0);
});

test('pending open is idempotent and cancelable; late source resolution cannot create a retired view', async t => {
  let complete, calls = 0;
  const f = await fixture(t, { maxViews: 1, resolveSource: actual => {
    calls++; return new Promise(resolve => { complete = () => resolve({ owner, assertCurrent: () => !actual.isDestroyed() }); });
  } });
  const first = f.open(), repeated = f.open();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal((await f.open(f.b, 'over-limit')).code, 'interactive_view_limit');
  f.service.closeSender(f.a);
  assert.equal((await first).code, 'interactive_view_stale');
  assert.equal((await repeated).code, 'interactive_view_stale');
  complete(); await Promise.resolve();
  const next = f.open(f.b, 'open-b'); await Promise.resolve(); await Promise.resolve();
  complete(); const reply = await next;
  assert.equal(reply.ok, true);
  f.service.dispose(); assert.equal(f.service.readState(f.b, { handle: reply.handle }).code, 'interactive_view_stale');
});

test('unsupported fields, forged owner and an arbitrary sender cannot open content', async t => {
  const f = await fixture(t);
  assert.equal((await f.open(sender())).code, 'interactive_scope_denied');
  assert.equal((await f.open(f.a, 'foreign', { ...f.receipt.reference, owner: { ...owner, conversationId: 'other-bot' } })).code, 'interactive_scope_denied');
  assert.equal((await f.service.open(f.a, { requestId: 'forged', reference: f.receipt.reference, granted: true })).code, 'interactive_request_invalid');
  const opened = await f.open();
  assert.equal(f.service.acquire(f.a, { handle: opened.handle, expectedRevision: 0, takeover: 'yes' }).code, 'interactive_request_invalid');
  assert.equal(f.service.acquire(f.a, { handle: opened.handle, expectedRevision: 4 }).code, 'interactive_state_conflict');
  assert.equal(f.service.readState(f.a, { handle: opened.handle }).state.stateRevision, 0);
});

test('cancel-open retires only the actual sender/request and a cancelled late reply cannot reopen it', async t => {
  let complete;
  const f = await fixture(t, { resolveSource: actual => new Promise(resolve => { complete = () => resolve({ owner, assertCurrent: () => !actual.isDestroyed() }); }) });
  const pending = f.open(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.service.cancelOpen(f.b, { requestId: 'open-a' }).ok, true);
  assert.equal(f.service.cancelOpen(f.a, { requestId: 'open-a' }).ok, true);
  assert.equal((await pending).code, 'interactive_view_stale');
  complete(); await Promise.resolve();
  const next = f.open(f.a, 'new-open'); await Promise.resolve(); await Promise.resolve(); complete();
  const reply = await next; assert.equal(reply.ok, true);
  f.service.acquire(f.a, { handle: reply.handle, expectedRevision: 0 });
  assert.equal(f.service.cancelOpen(f.b, { requestId: 'new-open' }).ok, true);
  assert.equal(f.service.readState(f.a, { handle: reply.handle }).ok, true);
  assert.equal(f.service.cancelOpen(f.a, { requestId: 'new-open' }).ok, true);
  assert.equal(f.service.readState(f.a, { handle: reply.handle }).code, 'interactive_view_stale');
});

test('corrupt state exposes only the verified saved summary, preserves the checkpoint and releases the failed view', async t => {
  const f = await fixture(t, { maxViews: 1 }), opened = await f.open();
  f.service.acquire(f.a, { handle: opened.handle, expectedRevision: 0 });
  f.service.release(f.a, { handle: opened.handle });
  const db = f.results.storage.connect(owner.workspaceId, true).db;
  const row = db.prepare('SELECT snapshot FROM states').get(), snapshot = JSON.parse(row.snapshot);
  snapshot.values.$budget = 999;
  const corrupt = JSON.stringify(snapshot); db.prepare('UPDATE states SET snapshot=?').run(corrupt);
  const failed = await f.open(f.a, 'corrupt');
  assert.equal(failed.ok, false); assert.equal(failed.code, 'interactive_state_corrupt');
  assert.equal(failed.handle, undefined); assert.equal(failed.result, undefined);
  assert.equal(failed.summary.title, 'Trial'); assert.deepEqual(failed.summary.reference, f.receipt.reference);
  assert.equal(failed.summary.source, undefined); assert.equal(failed.summary.operationId, undefined);
  const next = await f.open(f.b, 'retry-corrupt');
  assert.equal(next.code, 'interactive_state_corrupt', 'a failed open does not consume the view limit');
  assert.equal(db.prepare('SELECT snapshot FROM states').get().snapshot, corrupt);
});
