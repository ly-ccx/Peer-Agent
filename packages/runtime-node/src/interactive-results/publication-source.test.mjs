import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateDraft } from '@peer-agent/interactive-content';
import { createGoalPlanStore } from '../goal-plan-store.mjs';
import { createInteractiveResultStore } from './store.mjs';
import { createInteractivePublicationSource } from './publication-source.mjs';
import { createEvidenceReader } from '../../../../apps/desktop/electron/main/project-agent/evidence-reader.mjs';
import { createEvidenceDeliveryProjection } from '../../../../apps/desktop/electron/main/project-agent/evidence-deliveries.mjs';

async function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'peer-publication-source-')));
  const plans = createGoalPlanStore({ storeDir: path.join(root, 'plans') }), owner = { workspaceId: 'bot-a', conversationId: 'parent-a' };
  const store = createInteractiveResultStore({ rootDir: path.join(root, 'runtime'), assertCompatibility: () => plans.assertInteractiveEvidenceCompatible() });
  const sessions = new Map(); let parent = owner.conversationId;
  const model = { modelProviderId: 'fixture', providerId: 'fixture', modelId: 'fixture', family: 'fixture' };
  function plan(name, actualOwner = owner) {
    const value = plans.createPlan({ title: name, goal: name, conversationId: `worker-${name}`, status: 'executing', tasks: [],
      delegationOrigin: { workspaceId: actualOwner.workspaceId, parentConversationId: actualOwner.conversationId, sessionId: `session-${name}`,
        anchorMessageId: 'anchor', inputId: 'input', phase: 'running',
        modelSelection: { worker: model, explorer: model, verifier: model, resolvedAt: new Date().toISOString() } } });
    sessions.set(`session-${name}`, { sessionId: `session-${name}`, workspaceId: actualOwner.workspaceId, report: { planId: value.planId } });
    return value;
  }
  const draft = { publication: { kind: 'create' }, title: 'Saved trial', textFallback: 'Original unverified model explanation.', program: 'root=Metric("Value",2)', inputs: [] };
  async function publish(work, { call = 'same-call', candidate = draft, index = true, actualOwner = owner } = {}) {
    const receipt = store.commitPublication({ owner: actualOwner, source: { conversationId: work.conversationId, planId: work.planId,
      sessionId: work.delegationOrigin.sessionId, toolCallId: call, executionEpoch: 'epoch' }, draft: candidate,
    content: await validateDraft(candidate), provenance: [], dataLevel: 'D3_private', grant: { granted: true, grantId: 'fixture-grant', toolCallId: call } }, () => true);
    if (index && !receipt.unchanged) {
      plans.recordEvidenceRefs({ ...receipt.indexEntry, evidenceRefs: [receipt.indexEntry.evidenceRef] }, { durable: true });
      store.markIndexed(receipt.callRef, plans.findEvidenceIndexRecords([receipt.indexEntry.evidenceRef])[0]);
    }
    const operation = store.getOperation(receipt.callRef);
    return { ...operation, evidenceRef: operation.evidenceRef ?? operation.metadata.evidenceRef };
  }
  const ports = { resultStore: store, goalPlanStore: plans, getBotConversationId: workspace => workspace === owner.workspaceId ? parent : 'other-parent',
    getSession: id => sessions.get(id) };
  const source = createInteractivePublicationSource(ports);
  let legacyReads = 0, bodyReads = 0;
  const reader = createEvidenceReader({ resolveScopedRecord: source.resolveEvidence,
    findRecords: refs => { legacyReads++; return plans.findEvidenceIndexRecords(refs); },
    projectDeliveries: createEvidenceDeliveryProjection({ getConversationId: ports.getBotConversationId, getPlan: id => plans.getPlan(id), getSession: ports.getSession }),
    readArtifact: () => { bodyReads++; throw Error('Interactive summaries are not file paths'); }, readMessages: () => { bodyReads++; return []; } });
  const context = work => ({ workspaceId: owner.workspaceId, task: { planId: work.planId, sessionId: work.delegationOrigin.sessionId } });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { plans, store, owner, plan, publish, ports, source, reader, context, draft, sessions,
    changeOwner: () => { parent = 'new-parent'; }, reads: () => ({ legacyReads, bodyReads }) };
}

test('task evidence aliases resolve their actual worker operation despite identical wire IDs in other tasks and Bots', async t => {
  const f = await fixture(t), a = f.plan('a'), b = f.plan('b');
  const first = await f.publish(a), second = await f.publish(b, { candidate: { ...f.draft, title: 'Second trial' } });
  const foreignOwner = { workspaceId: 'bot-b', conversationId: 'other-parent' }, foreign = f.plan('foreign', foreignOwner);
  await f.publish(foreign, { actualOwner: foreignOwner });
  for (const [work, receipt] of [[a, first], [b, second]]) {
    const reply = f.reader('tool-result://same-call', { context: f.context(work) });
    assert.equal(reply.availability, 'available'); assert.equal(reply.deliveries.length, 1);
    assert.deepEqual(reply.deliveries[0].interactiveReference, receipt.reference);
    assert.equal(reply.deliveries[0].evidenceRef, receipt.evidenceRef); assert.equal(reply.source.evidenceRef, receipt.evidenceRef);
    assert.equal(reply.deliveries[0].reference, undefined); assert.match(reply.text, /Saved model summary, unverified/);
  }
  assert.deepEqual(f.reads(), { legacyReads: 0, bodyReads: 0 });
  assert.equal(f.reader('tool-result://same-call', { context: f.context(foreign) }).deliveryStatus, 'scope_denied');
});

test('fixed publication evidence exposes its original bounded model summary without a file read or task inference', async t => {
  const f = await fixture(t), work = f.plan('a'), receipt = await f.publish(work);
  const fixed = f.reader(receipt.evidenceRef, { context: { workspaceId: f.owner.workspaceId } });
  assert.equal(fixed.text, 'Saved model summary, unverified\nOriginal unverified model explanation.');
  assert.equal(fixed.truncated, false); assert.deepEqual(fixed.deliveries[0].interactiveReference, receipt.reference);
  const metadata = f.reader(receipt.evidenceRef, { metadataOnly: true, context: f.context(work) });
  assert.equal(metadata.text, undefined); assert.equal(metadata.source.evidenceRef, receipt.evidenceRef);
  assert.equal(f.source.resolveEvidence('tool-result://same-call', { workspaceId: f.owner.workspaceId }), null);
  assert.equal(f.source.resolveEvidence('file:///tmp/pretend.json', f.context(work)), null);
  assert.deepEqual(f.reads(), { legacyReads: 1, bodyReads: 0 }, 'metadata-only requests stay on the index and never load publication content');
});

test('unknown task identities, owner changes and missing actual session reports fail before publication content or legacy fallbacks', async t => {
  const f = await fixture(t), work = f.plan('a'); await f.publish(work);
  const getVersion = f.store.getVersion; let contentReads = 0;
  f.store.getVersion = (...args) => { contentReads++; return getVersion(...args); };
  for (const context of [{ ...f.context(work), workspaceId: '../bot-a' }, { workspaceId: 'bot-a', task: { planId: work.planId, sessionId: 'other' } }]) {
    assert.equal(f.reader('tool-result://same-call', { context }).deliveryStatus, 'scope_denied');
  }
  f.sessions.delete(work.delegationOrigin.sessionId);
  assert.equal(f.reader('tool-result://same-call', { context: f.context(work) }).code, 'READ_FAILED');
  const receipt = f.store.getOperation({ owner: f.owner, conversationId: work.conversationId, toolCallId: 'same-call' });
  assert.equal(f.reader(receipt.metadata.evidenceRef, { context: { workspaceId: f.owner.workspaceId } }).code, 'READ_FAILED');
  f.changeOwner();
  assert.equal(f.reader('tool-result://same-call', { context: f.context(work) }).deliveryStatus, 'scope_denied');
  assert.deepEqual(f.reads(), { legacyReads: 0, bodyReads: 0 });
  assert.equal(contentReads, 0, 'missing session authority is rejected before reading any immutable program or data object');
});

test('an index-pending operation never becomes a delivery or starts reconciliation on a human read', async t => {
  const f = await fixture(t), work = f.plan('a'), receipt = await f.publish(work, { index: false });
  const reply = f.reader('tool-result://same-call', { context: f.context(work) });
  assert.equal(reply.availability, 'unavailable'); assert.equal(reply.code, 'READ_FAILED');
  assert.equal(f.store.getOperation(receipt.callRef).publicationStatus, 'index_pending');
  assert.equal(f.plans.findEvidenceIndexRecords([receipt.evidenceRef]).length, 0);
  assert.deepEqual(f.reads(), { legacyReads: 0, bodyReads: 0 });
});

test('legacy non-interactive task evidence keeps its existing resource projection when the old Plan has no parent Bot binding', async t => {
  const f = await fixture(t), legacy = f.plan('legacy', { ...f.owner, conversationId: undefined });
  assert.equal(legacy.delegationOrigin.parentConversationId, undefined);
  const evidenceRef = 'tool-result://legacy-file';
  f.plans.recordEvidenceRefs({ evidenceRefs: [evidenceRef], planId: legacy.planId, conversationId: legacy.conversationId,
    toolCallId: 'legacy-file', capabilityId: 'local.file.read', toolName: 'read_file',
    userArtifacts: [{ kind: 'file', ref: 'file:///project/legacy.txt', label: 'legacy.txt' }] });
  const reply = f.reader(evidenceRef, { context: f.context(legacy) });
  assert.equal(reply.deliveryStatus, 'available'); assert.equal(reply.deliveries[0].kind, 'file');
  assert.equal(reply.deliveries[0].reference.path, '/project/legacy.txt');
});

test('a genuine unchanged revision resolves the original source task without creating or rebinding a publication', async t => {
  const f = await fixture(t), original = f.plan('a'), revision = f.plan('b'), first = await f.publish(original);
  const unchanged = await f.publish(revision, { candidate: { ...f.draft, publication: { kind: 'revise', base: first.reference } } });
  assert.equal(unchanged.unchanged, true);
  const reply = f.reader('tool-result://same-call', { context: f.context(revision) });
  assert.equal(reply.availability, 'available'); assert.equal(reply.source.evidenceRef, first.evidenceRef);
  const resolved = f.source.resolveEvidence('tool-result://same-call', f.context(revision));
  assert.equal(resolved.record.planId, original.planId); assert.deepEqual(resolved.context, f.context(original));
  assert.deepEqual(reply.deliveries[0].interactiveReference, first.reference);
  assert.equal(f.store.getVersion(first.reference).source.planId, original.planId);
  assert.equal(f.plans.listEvidenceIndex().length, 1);
  assert.equal(f.reader(first.evidenceRef, { context: f.context(revision) }).deliveryStatus, 'scope_denied', 'a URI alone cannot borrow the unchanged operation relationship');
});

test('missing or mismatched canonical publication metadata cannot be replaced by an alias, fallback, latest head or forged index', async t => {
  const f = await fixture(t), work = f.plan('a'), receipt = await f.publish(work), [canonical] = f.plans.findEvidenceIndexRecords([receipt.evidenceRef]);
  for (const patch of [null, { createdAt: '2000-01-01T00:00:00.000Z' }, { toolCallId: 'other' }, { capabilityId: 'local.file.write' },
    { toolName: 'read_file' }, { userArtifacts: [] }, { userArtifacts: [{ ...canonical.userArtifacts[0], label: 'Forged name' }] },
    { userArtifacts: [{ ...canonical.userArtifacts[0], specHash: 'sha256:' + 'f'.repeat(64) }] }]) {
    const source = createInteractivePublicationSource({ ...f.ports, goalPlanStore: { getPlan: f.plans.getPlan,
      findEvidenceIndexRecords: () => patch ? [{ ...canonical, ...patch }] : [] } });
    assert.throws(() => source.resolveEvidence('tool-result://same-call', f.context(work)), { code: 'interactive_publication_unavailable' });
  }
});
