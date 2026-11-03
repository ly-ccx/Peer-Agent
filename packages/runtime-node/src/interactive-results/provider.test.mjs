import assert from 'node:assert/strict';
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, statSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createGoalPlanStore } from '../goal-plan-store.mjs';
import { createInteractiveResultStore } from './store.mjs';
import { createInteractiveStateStore } from './state-store.mjs';
import { createInteractiveMaterialSource } from './material-source.mjs';
import { createInteractiveResultProvider } from './provider.mjs';
import { normalizeEvidenceIndexRecord as legacyNormalize } from './test-fixtures/rc35-evidence-normalizer.mjs';

const PUBLISH = 'local.interactive.publish', INSPECT = 'local.interactive.inspect';
const owner = { workspaceId: 'bot-a', conversationId: 'parent-a' };
const now = () => '2026-11-03T00:00:00.000Z';
const draft = { publication: { kind: 'create' }, title: 'Budget', textFallback: 'Model estimate: budget times two.',
  program: '$budget=100\nroot=Col([NumberInput("budget","Budget",$budget,0,1000,1),Metric("Total",$budget*2)])', inputs: [] };
function fixture(t, storeOptions = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'interactive-provider-')));
  const index = createGoalPlanStore({ storeDir: path.join(root, 'goals') });
  const clock = storeOptions.now ?? now;
  const store = createInteractiveResultStore({ rootDir: path.join(root, 'runtime'), now: clock,
    assertCompatibility: () => index.assertInteractiveEvidenceCompatible(), ...storeOptions });
  const states = createInteractiveStateStore({ resultStore: store, now });
  const counts = { permissions: 0, materialReads: 0, sourceAdmissions: 0, permissionDataLevels: [] };
  let active = true, indexAvailable = true, acknowledgeIndex = true, approve = true, role = 'session_worker', allowResult = true, allowFollowup = true, conversationId = 'worker-a', dataLevel = 'D2_sensitive';
  const authority = ({ call }) => ({ owner, role, source: { conversationId, planId: 'plan-a', sessionId: 'session-a', executionEpoch: 'epoch-a', toolCallId: call.toolCallId },
    dataLevel, currentDataLevel: () => store.ownerDataLevel(owner, dataLevel), capabilityIds: [PUBLISH, INSPECT], assertCurrent: () => active,
    admitResult: () => allowResult, admitPublication: () => allowResult, admitFollowup: () => allowFollowup });
  const materialSource = createInteractiveMaterialSource({ now: clock,
    admitSource: () => { counts.sourceAdmissions++; return true; },
    readToolResult: source => { counts.materialReads++; return store.readMaterial(owner, source); } });
  const provider = createInteractiveResultProvider({ store, stateStore: states, materialSource, resolveAuthority: authority, now: clock, index: {
    assertInteractiveEvidenceCompatible: () => index.assertInteractiveEvidenceCompatible(),
    recordEvidenceRefs: (entry, options) => { assert.equal(options.durable, true); if (!indexAvailable) throw Error('index offline'); const rows = index.recordEvidenceRefs(entry, options);
      if (!acknowledgeIndex) throw Error('index confirmation lost'); return rows; },
    findEvidenceIndexRecords: refs => index.findEvidenceIndexRecords(refs),
  } });
  const execute = (capabilityId, args, id = 'publish-a', context = {}) => provider.executeCapability({ call: { toolCallId: id, capabilityId, arguments: args } }, {
    requestPermission: async request => { counts.permissions++; counts.permissionDataLevels.push(request.dataLevel);
      assert.equal(request.scope.kind, 'interactive-result'); assert.equal(request.scope.dataLevel, request.dataLevel); return { granted: approve }; }, ...context });
  const publish = (args = draft, id) => execute(PUBLISH, args, id);
  const inspect = (reference, view, extras = {}, id = 'inspect-a') => execute(INSPECT, { target: { kind: 'result', reference }, view, ...extras }, id);
  t.after(() => { states.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, index, store, states, provider, counts, publish, inspect, execute,
    setActive: value => { active = value; }, setIndex: value => { indexAvailable = value; }, setApproval: value => { approve = value; },
    setRole: value => { role = value; }, setAdmission: value => { allowResult = value; }, setFollowup: value => { allowFollowup = value; },
    setConversation: value => { conversationId = value; }, setIndexAcknowledged: value => { acknowledgeIndex = value; }, setDataLevel: value => { dataLevel = value; } };
}
test('real Provider publishes through scoped approval, isolated validation, SQLite and actual canonical EvidenceIndex', async t => {
  const f = fixture(t), result = await f.publish();
  assert.equal(result.result.status, 'success'); assert.equal(result.grant.granted, true);
  assert.equal(result.grant.scope.kind, 'interactive-result'); assert.equal(f.counts.permissions, 1);
  assert.equal(result.grant.scope.source.conversationId, 'worker-a'); assert.equal(result.grant.scope.source.executionEpoch, 'epoch-a');
  const ref = result.result.outputPreview.reference;
  const records = f.index.findEvidenceIndexRecords([result.result.outputPreview.artifactRef]);
  assert.equal(records[0].userArtifacts[0].kind, 'interactive');
  assert.deepEqual(records[0].userArtifacts[0].reference, ref);
  assert.equal(records[0].conversationId, 'worker-a');
  assert.equal(f.store.getVersion(ref).source.toolCallId, 'publish-a');
  assert.equal(f.store.listPending(owner).length, 0);
  const retry = await f.publish();
  assert.deepEqual(retry.result.outputPreview.reference, ref); assert.equal(f.counts.permissions, 1, 'reconciliation is not a new execution approval');
  assert.equal(retry.grant.scope.operation, 'receipt-read');
  const conflict = await f.publish({ ...draft, title: 'changed' });
  assert.equal(conflict.result.outputPreview.reason, 'publication_parameter_conflict');
});
test('denial, stale identity, invalid program and real validation cancellation never create a publication', async t => {
  const f = fixture(t);
  f.setApproval(false); assert.equal((await f.publish()).result.status, 'denied');
  f.setApproval(true); f.setActive(false); assert.equal((await f.publish()).result.status, 'denied');
  f.setActive(true);
  const invalid = await f.publish({ ...draft, program: 'root=HtmlView("x")' });
  assert.equal(invalid.result.status, 'failed');
  const controller = new AbortController(); controller.abort();
  assert.equal((await f.execute(PUBLISH, draft, 'aborted', { signal: controller.signal })).result.status, 'cancelled');
  assert.deepEqual(f.store.listPending(owner), []);
  assert.deepEqual(f.index.listEvidenceIndex(), []);
});
test('committed pending publication reports actual effect, survives cancellation and reconciles without replay or permission', async t => {
  const f = fixture(t); f.setIndex(false);
  const failed = await f.publish(), preview = failed.result.outputPreview;
  assert.equal(failed.result.status, 'failed'); assert.equal(preview.reason, 'publication_index_pending');
  assert.equal(preview.effectCommitted, true); assert.equal(preview.recovery, 'reconcile_only');
  assert.throws(() => f.store.getVersion(preview.reference), { code: 'publication_index_pending' });
  f.setActive(false); f.setIndex(true);
  const recovered = f.provider.recoverOwner(owner, candidate => candidate.workspaceId === owner.workspaceId);
  assert.equal(recovered[0].publicationStatus, 'published');
  assert.equal(f.counts.permissions, 1); assert.equal(f.counts.materialReads, 0);
  assert.deepEqual(f.store.getVersion(preview.reference).reference, preview.reference);
  assert.throws(() => f.provider.recoverOwner(owner, () => false), { code: 'interactive_scope_denied' });
});

test('failed preparation pins call parameters and permits only two content repairs across new wire call IDs', async t => {
  const f = fixture(t), invalid = { ...draft, program: 'root=HtmlView("forbidden")' };
  const first = await f.publish(invalid, 'bad-a');
  assert.equal(first.result.status, 'failed');
  const permissions = f.counts.permissions;
  const replay = await f.publish(invalid, 'bad-a');
  assert.equal(replay.result.outputPreview.reason, first.result.outputPreview.reason);
  assert.equal(f.counts.permissions, permissions);
  assert.equal((await f.publish(draft, 'bad-a')).result.outputPreview.reason, 'publication_parameter_conflict');
  for (const id of ['bad-b', 'bad-c']) assert.notEqual((await f.publish(invalid, id)).result.outputPreview.reason, 'interactive_repair_limit');
  assert.equal((await f.publish(draft, 'bad-d')).result.outputPreview.reason, 'interactive_repair_limit');
  const status = await f.execute(INSPECT, { target: { kind: 'publication', reference: { owner, conversationId: 'worker-a', toolCallId: 'bad-a' } }, view: 'metadata' }, 'read-bad');
  assert.equal(status.result.outputPreview.publicationStatus, 'not_committed');
  assert.equal(status.result.outputPreview.preparationStatus, 'failed');
  assert.equal(f.index.listEvidenceIndex().length, 0);
});

test('a successful corrected candidate resets the content repair budget for a subsequent independent result', async t => {
  const f = fixture(t), invalid = { ...draft, program: 'root=HtmlView("forbidden")' };
  assert.equal((await f.publish(invalid, 'bad-a')).result.status, 'failed');
  assert.equal((await f.publish(draft, 'good-a')).result.status, 'success');
  for (const id of ['bad-b', 'bad-c', 'bad-d']) assert.notEqual((await f.publish(invalid, id)).result.outputPreview.reason, 'interactive_repair_limit');
  assert.equal((await f.publish(draft, 'bad-e')).result.outputPreview.reason, 'interactive_repair_limit');
});
test('a lost durable index acknowledgment reconciles without another index row or user artifact', async t => {
  const f = fixture(t); f.setIndexAcknowledged(false);
  const failed = await f.publish();
  assert.equal(failed.result.outputPreview.publicationStatus, 'index_pending');
  const file = path.join(f.root, 'goals', 'evidence-index.jsonl'), bytes = statSync(file).size;
  f.setIndexAcknowledged(true);
  assert.equal(f.provider.recoverOwner(owner, () => true)[0].publicationStatus, 'published');
  assert.equal(statSync(file).size, bytes);
  assert.equal(f.index.listEvidenceIndex().length, 1);
  assert.equal(f.counts.permissions, 1);
});

test('recovery losing the current owner lease cannot clear the pending responsibility after index append', async t => {
  const f = fixture(t); f.setIndex(false);
  const pending = await f.publish();
  let owned = true;
  const recovery = createInteractiveResultProvider({ store: f.store, index: {
    assertInteractiveEvidenceCompatible: () => true,
    recordEvidenceRefs(entry, options) { f.index.recordEvidenceRefs(entry, options); owned = false; },
    findEvidenceIndexRecords: refs => f.index.findEvidenceIndexRecords(refs),
  } });
  const first = recovery.recoverOwner(owner, () => owned);
  assert.equal(first[0].code, 'interactive_execution_stale');
  assert.equal(f.store.listPending(owner).length, 1);
  assert.equal(f.index.listEvidenceIndex().length, 1);
  owned = true; f.setIndex(true);
  assert.equal(f.provider.recoverOwner(owner, () => owned)[0].publicationStatus, 'published');
  assert.deepEqual(f.store.getVersion(pending.result.outputPreview.reference).reference, pending.result.outputPreview.reference);
  assert.equal(f.index.listEvidenceIndex().length, 1);
});
test('the same model wire call ID in two worker conversations has separate canonical publication evidence', async t => {
  const f = fixture(t), first = await f.publish();
  f.setConversation('worker-b');
  const second = await f.publish();
  assert.equal(second.result.status, 'success', JSON.stringify(second.result.outputPreview));
  assert.notEqual(first.result.outputPreview.artifactRef, second.result.outputPreview.artifactRef);
  const records = f.index.listEvidenceIndex();
  assert.equal(records.length, 2); assert.deepEqual(records.map(row => row.conversationId), ['worker-a', 'worker-b']);
  assert.equal(records.every(row => row.toolCallId === 'publish-a'), true);
});
test('identical model-data revision preserves the original artifact and capture times despite a later validation clock', async t => {
  let tick = 0;
  const f = fixture(t, { now: () => new Date(Date.parse(now()) + ++tick * 1000).toISOString() });
  const input = { ...draft, inputs: [{ bindingId: 'rows', source: { kind: 'model-data', value: [{ id: 1, cost: 5 }] } }],
    program: 'root=Metric("Cost",@Total(@Data("rows"),"cost"))' };
  const first = await f.publish(input), ref = first.result.outputPreview.reference;
  const capturedAt = f.store.getVersion(ref).provenance[0].capturedAt;
  const revised = await f.publish({ ...input, publication: { kind: 'revise', base: ref } }, 'publish-b');
  assert.equal(revised.result.status, 'success'); assert.equal(revised.result.outputPreview.unchanged, true);
  assert.deepEqual(revised.result.outputPreview.reference, ref); assert.equal(f.store.getVersion(ref).provenance[0].capturedAt, capturedAt);
  assert.equal(f.index.listEvidenceIndex().length, 1);
});
test('a stricter actual context classification cannot be lost by an otherwise identical tool-data revision', async t => {
  const f = fixture(t);
  const source = f.store.recordMaterial({ owner, source: { kind: 'tool-result', conversationId: 'worker-a', toolCallId: 'read-a' }, value: [{ id: 1, cost: 5 }],
    dataLevel: 'D1_internal', observedAt: now(), truncated: false, redacted: false, evidenceRefs: ['tool-result://read-a'] }, () => true);
  const input = { ...draft, inputs: [{ bindingId: 'rows', source }], program: 'root=Metric("Cost",@Total(@Data("rows"),"cost"))' };
  const first = await f.publish(input), ref = first.result.outputPreview.reference;
  f.setDataLevel('D4_regulated');
  const revised = await f.publish({ ...input, publication: { kind: 'revise', base: ref } }, 'publish-b');
  assert.equal(revised.result.status, 'success'); assert.notEqual(revised.result.outputPreview.reference.contentVersion, ref.contentVersion);
  assert.equal(revised.result.evidence.dataLevel, 'D4_regulated');
});
test('a crash after durable commit is reported as pending and querying original operation confirms the real original fact', async t => {
  const f = fixture(t, { onStep: stage => { if (stage === 'committed') throw Error('lost response'); } });
  const failed = await f.publish();
  assert.equal(failed.result.outputPreview.effectCommitted, true);
  f.setRole('project_agent');
  const checked = await f.execute(INSPECT, { target: { kind: 'publication', reference: failed.result.outputPreview.callRef }, view: 'metadata' }, 'status-a');
  assert.equal(checked.result.outputPreview.publicationStatus, 'published');
  assert.equal(checked.result.evidence.toolCallId, 'status-a');
  assert.equal(f.counts.permissions, 1);
});
test('a commit followed by unreadable operation storage is unknown, never falsely not_committed or safe to replay', async t => {
  let unreadable = false;
  const f = fixture(t, { onStep: stage => { if (stage === 'committed') { unreadable = true; throw Error('store unavailable'); } } });
  const original = f.store.getOperation;
  f.store.getOperation = (...args) => { if (unreadable) throw Object.assign(Error('read failed'), { code: 'EIO' }); return original(...args); };
  const failed = await f.publish();
  assert.equal(failed.result.outputPreview.reason, 'publication_unknown'); assert.equal(failed.result.outputPreview.publicationStatus, 'unknown');
  assert.equal(failed.result.outputPreview.effectCommitted, undefined); assert.equal(failed.result.outputPreview.recovery, 'reconcile_only');
  unreadable = false;
  assert.equal(f.provider.recoverOwner(owner, () => true)[0].publicationStatus, 'published');
  assert.equal(f.counts.permissions, 1);
});
test('main Bot is metadata/text only, Explorer cannot inspect, and no non-worker role can publish', async t => {
  const f = fixture(t), published = await f.publish(), ref = published.result.outputPreview.reference;
  for (const role of ['project_agent', 'explorer', 'verifier', 'visual_verifier']) {
    f.setRole(role);
    const denied = await f.publish(draft, `publish-${role}`);
    assert.equal(denied.result.status, 'denied'); assert.equal(denied.result.outputPreview.reason, 'interactive_role_denied');
  }
  f.setRole('project_agent');
  assert.equal((await f.inspect(ref, 'text')).result.outputPreview.classification, 'model-text-fallback');
  assert.equal((await f.inspect(ref, 'program')).result.status, 'denied');
  f.setRole('explorer'); assert.equal((await f.inspect(ref, 'metadata')).result.status, 'denied');
  f.setRole('verifier'); f.setAdmission(false); assert.equal((await f.inspect(ref, 'evaluate')).result.status, 'denied');
});
test('Verifier reads actual fixed program/data and independently evaluates admitted frozen user values rather than live state', async t => {
  const f = fixture(t), published = await f.publish(), ref = published.result.outputPreview.reference;
  const identity = { viewId: 'view-a', windowId: 'window-a', generation: 'generation-a' }, current = () => true;
  const writer = f.states.acquire({ reference: ref, identity, expectedRevision: 0 }, current);
  const saved = f.states.save({ reference: ref, identity, writer, expectedRevision: 0, requestId: 'save-a', values: { $budget: 250 }, inputDrafts: {} }, current);
  const frozen = f.states.prepareFollowup({ reference: ref, identity, writer, stateRevision: 1, stateDigest: saved.stateDigest, fields: ['$budget'], requestId: 'followup-a' }, current);
  f.states.save({ reference: ref, identity, writer, expectedRevision: 1, requestId: 'save-b', values: { $budget: 900 }, inputDrafts: {} }, current);
  f.setRole('verifier');
  assert.equal((await f.inspect(ref, 'program')).result.outputPreview.text, draft.program);
  const initial = await f.inspect(ref, 'evaluate');
  assert.match(initial.result.outputPreview.text, /Total: 200/);
  const evaluated = await f.inspect(ref, 'evaluate', { followupId: frozen.followupId }, 'evaluate-a');
  assert.match(evaluated.result.outputPreview.text, /Total: 500/); assert.doesNotMatch(evaluated.result.outputPreview.text, /1800/);
  assert.equal(evaluated.result.outputPreview.stateSource.stateRevision, 1);
  assert.equal(evaluated.result.evidence.toolCallId, 'evaluate-a');
  f.setFollowup(false); assert.equal((await f.inspect(ref, 'evaluate', { followupId: frozen.followupId })).result.status, 'denied');
});
test('canonical source snapshots carry actual privacy/classification and admitted selection into inspect Evidence', async t => {
  const f = fixture(t);
  const source = f.store.recordMaterial({ owner, source: { kind: 'tool-result', conversationId: 'worker-a', toolCallId: 'read-a' }, value: [{ id: 1, cost: 5 }, { id: 2, cost: 7 }],
    dataLevel: 'D3_private', observedAt: now(), truncated: true, redacted: true, evidenceRefs: ['tool-result://read-a'] }, () => true);
  const result = await f.publish({ ...draft, inputs: [{ bindingId: 'facts', source }], program: 'root=Table("Actual observed rows",[{key:"cost",label:"Cost"}],@Data("facts"),"id")' });
  assert.equal(result.result.status, 'success'); assert.equal(result.result.evidence.dataLevel, 'D3_private');
  f.setRole('verifier');
  const inspected = await f.inspect(result.result.outputPreview.reference, 'data', { bindingId: 'facts', selector: { start: 1, limit: 1, fields: ['cost'] } });
  assert.equal(inspected.result.outputPreview.text, '[{"cost":7}]');
  assert.equal(inspected.result.outputPreview.source.truncated, true); assert.equal(inspected.result.outputPreview.source.redacted, true);
  assert.equal(inspected.result.evidence.dataLevel, 'D3_private'); assert.equal(f.counts.sourceAdmissions, 2); assert.equal(f.counts.materialReads, 2);
  assert.deepEqual(f.counts.permissionDataLevels, ['D3_private']);
});

test('classification is checked before approval and a stricter post-approval source cannot be committed under the earlier scope', async t => {
  const f = fixture(t);
  const source = f.store.recordMaterial({ owner, source: { kind: 'tool-result', conversationId: 'worker-a', toolCallId: 'read-a' },
    value: [{ cost: 10 }], dataLevel: 'D3_private', observedAt: now(), truncated: false, redacted: false, evidenceRefs: ['tool-result://read-a'] }, () => true);
  const read = f.store.readMaterial;
  let level = 'D3_private';
  f.store.readMaterial = (...args) => ({ ...read(...args), dataLevel: level });
  const result = await f.execute(PUBLISH, { ...draft, program: 'root=Metric("Cost",@Total(@Data("rows"),"cost"))',
    inputs: [{ bindingId: 'rows', source }] }, 'classification-drift', { requestPermission: async request => {
    assert.equal(request.dataLevel, 'D3_private'); assert.equal(request.scope.dataLevel, 'D3_private'); level = 'D4_regulated'; return { granted: true };
  } });
  assert.equal(result.result.outputPreview.reason, 'material_classification_changed');
  assert.equal(result.result.outputPreview.publicationStatus, 'not_committed');
  assert.equal(f.index.listEvidenceIndex().length, 0);
});

test('a stricter owner observation while approval is pending invalidates that scope even without input references', async t => {
  const f = fixture(t);
  const result = await f.execute(PUBLISH, draft, 'owner-classification-drift', { requestPermission: async request => {
    assert.equal(request.dataLevel, 'D2_sensitive');
    f.store.rememberObservationLevel(owner, 'D4_regulated', () => true);
    return { granted: true };
  } });
  assert.equal(result.result.outputPreview.reason, 'material_classification_changed');
  assert.equal(result.result.outputPreview.publicationStatus, 'not_committed');
  assert.equal(f.index.listEvidenceIndex().length, 0);
  assert.equal(f.store.ownerDataLevel(owner, 'D2_sensitive'), 'D4_regulated');
});
test('legacy lossy appends, wrappers and already-open append descriptors preserve the original canonical publication and owner', async t => {
  const f = fixture(t), file = path.join(f.root, 'goals', 'evidence-index.jsonl');
  mkdirSync(path.dirname(file), { recursive: true });
  // This descriptor predates the new kind, as in an already-running older process.
  const fd = openSync(file, 'a'); t.after(() => closeSync(fd));
  const result = await f.publish(), ref = result.result.outputPreview.reference;
  const original = f.index.findEvidenceIndexRecords([result.result.outputPreview.artifactRef])[0];
  const lossy = legacyNormalize({ ...original, conversationId: 'wrong-parent', toolName: 'goal_update_task', createdAt: now() });
  assert.equal(lossy.userArtifacts, undefined, 'the fixed old normalizer actually drops the new kind');
  writeSync(fd, JSON.stringify(lossy) + '\n');
  // An old provider re-indexing the same call also drops the new union member.
  appendFileSync(file, JSON.stringify({ ...lossy, toolName: 'publish_interactive_result' }) + '\n');
  const nextHost = createGoalPlanStore({ storeDir: path.dirname(file) });
  const actual = nextHost.findEvidenceIndexRecords([result.result.outputPreview.artifactRef])[0];
  assert.equal(actual.conversationId, 'worker-a'); assert.equal(actual.toolName, 'publish_interactive_result');
  assert.deepEqual(actual.userArtifacts[0].reference, ref);
  const full = nextHost.listEvidenceIndex().find(record => record.evidenceRef === result.result.outputPreview.artifactRef);
  assert.deepEqual(full.userArtifacts[0].reference, ref); assert.equal(full.conversationId, 'worker-a');
  assert.equal(nextHost.assertInteractiveEvidenceCompatible(), true);
});
