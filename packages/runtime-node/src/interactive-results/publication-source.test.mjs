import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateDraft } from '@peer-agent/interactive-content';
import { createGoalPlanStore } from '../goal-plan-store.mjs';
import { createInteractiveResultStore } from './store.mjs';
import { createInteractivePublicationSource } from './publication-source.mjs';
import { createPortableInteractiveSummaryReader } from './portable-summary.mjs';
import { createInteractiveTextReader } from './text-reader.mjs';
import { readStoredWorkHistory } from '../../../conversation-store/src/persisted-history.mjs';
import { createEvidenceReader } from '../../../../apps/desktop/electron/main/project-agent/evidence-reader.mjs';
import { createEvidenceDeliveryProjection } from '../../../../apps/desktop/electron/main/project-agent/evidence-deliveries.mjs';

async function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'peer-publication-source-')));
  const plans = createGoalPlanStore({ storeDir: path.join(root, 'plans') }), owner = { workspaceId: 'bot-a', conversationId: 'parent-a' };
  const store = createInteractiveResultStore({ rootDir: path.join(root, 'runtime'), assertCompatibility: () => plans.assertInteractiveEvidenceCompatible() });
  const sessions = new Map(); let parent = owner.conversationId;
  const model = { modelProviderId: 'fixture', providerId: 'fixture', modelId: 'fixture', family: 'fixture' };
  function plan(name, actualOwner = owner, evidenceRefs = []) {
    const value = plans.createPlan({ title: name, goal: name, conversationId: `worker-${name}`, status: 'executing', tasks: [], evidenceRefs,
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
  return { root, plans, store, owner, plan, publish, ports, source, reader, context, draft, sessions,
    changeOwner: () => { parent = 'new-parent'; }, reads: () => ({ legacyReads, bodyReads }) };
}

test('portable history displays the saved fixed summary without creating a local publication or delivery', async t => {
  const f = await fixture(t), work = f.plan('portable'), published = await f.publish(work);
  const reference = published.reference, ref = published.evidenceRef, sessionId = work.delegationOrigin.sessionId;
  const folder = path.join(f.root, 'portable-conversations'), runtime = path.join(f.root, 'portable-runtime');
  mkdirSync(folder);
  const file = path.join(folder, `${work.conversationId}.jsonl`);
  const index = [
    { id: f.owner.conversationId, role: 'project_agent', workspaceId: f.owner.workspaceId },
    { id: work.conversationId, role: 'work_session', workspaceId: f.owner.workspaceId, parentConversationId: f.owner.conversationId,
      delegation: { sessionId }, contentRevision: 1 },
  ];
  const jsonLines = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  writeFileSync(path.join(folder, 'index.jsonl'), jsonLines(index));
  const output = { kind: 'interactive_publication', publicationStatus: 'published', reference, callRef: published.callRef,
    artifactRef: ref, title: f.draft.title, textFallback: f.draft.textFallback };
  const message = { id: 'committed-worker-message', role: 'assistant', interrupted: false, segments: [{ type: 'tool-call',
    tool: 'publish_interactive_result', status: 'completed', toolCallId: published.callRef.toolCallId,
    result: JSON.stringify({ status: 'completed', output, evidenceRefs: [ref] }) }] };
  writeFileSync(file, jsonLines([message]));
  const resultStore = createInteractiveResultStore({ rootDir: runtime });
  t.after(() => resultStore.close());
  const readPortableSummary = createPortableInteractiveSummaryReader({ goalPlanStore: f.plans,
    readWorkHistory: scope => readStoredWorkHistory(folder, scope) });
  const readText = createInteractiveTextReader({ resultStore, readPortableSummary, assertOwner: owner => f.ports.getBotConversationId(owner.workspaceId) === owner.conversationId });
  const source = createInteractivePublicationSource({ ...f.ports, resultStore, readPortableSummary });
  const readEvidence = createEvidenceReader({ resolveScopedRecord: source.resolveEvidence,
    findRecords: () => { throw Error('Portable evidence must use the canonical scoped result'); },
    projectDeliveries: () => { throw Error('Portable text grants no local delivery'); } });
  const summary = readText(reference);
  assert.equal(summary.availability, 'origin_only');
  assert.equal(summary.textFallback, f.draft.textFallback);
  assert.deepEqual(summary.source, { conversationId: work.conversationId, toolCallId: published.callRef.toolCallId, planId: work.planId, sessionId });
  assert.equal(summary.dataLevel, undefined);
  const shown = readEvidence(ref, { context: f.context(work) });
  assert.equal(shown.interactiveAvailability, 'origin_only');
  assert.equal(shown.text, f.draft.textFallback);
  assert.equal(shown.deliveries, undefined);
  assert.equal(readEvidence(ref, { context: f.context(f.plan('different-task')) }).deliveryStatus, 'scope_denied');
  assert.throws(() => createInteractiveTextReader({ resultStore, assertOwner: () => true })(reference), { code: 'interactive_result_unavailable' });
  assert.equal(existsSync(runtime), false);

  writeFileSync(file, jsonLines([message, { ...message, id: 'duplicate' }]));
  assert.throws(() => readText(reference), { code: 'interactive_result_unavailable' });
  writeFileSync(file, jsonLines([{ ...message, interrupted: true }]));
  assert.throws(() => readText(reference), { code: 'interactive_result_unavailable' });
  writeFileSync(file, jsonLines([message]));
  writeFileSync(path.join(folder, `${work.conversationId}.stream.json`), JSON.stringify({ version: 1,
    conversationId: work.conversationId, messageId: message.id, patch: {} }));
  assert.throws(() => readText(reference), { code: 'interactive_result_unavailable' });
  f.changeOwner();
  assert.throws(() => readText(reference), { code: 'interactive_scope_denied' });
});

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
  assert.deepEqual(f.source.replyReferences({ ...f.owner, sessionIds: [legacy.delegationOrigin.sessionId] }), [], 'legacy status replies gain no result card and remain available');
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

test('outward reports resolve only actual task references and reply references use metadata without reading program/data or recursing into reports', async t => {
  const f = await fixture(t), alias = 'tool-result://same-call', work = f.plan('a', f.owner, [alias, 'ordinary-evidence']), receipt = await f.publish(work);
  const forbidden = () => { throw Error('metadata projection cannot load content or a full session report'); };
  f.store.storage.readObject = forbidden;
  const source = createInteractivePublicationSource({ ...f.ports, getSession: (id, detail) => {
    assert.equal(detail, 'summary'); return f.sessions.get(id);
  } });
  assert.deepEqual(source.projectReportEvidence(work, [alias, 'ordinary-evidence']), [receipt.evidenceRef, 'ordinary-evidence']);
  assert.deepEqual(source.projectReportEvidence(work, ['tool-result://unrecorded']), ['tool-result://unrecorded']);
  assert.deepEqual(source.replyReferences({ ...f.owner, sessionIds: [work.delegationOrigin.sessionId] }), [receipt.evidenceRef]);
  assert.deepEqual(f.plans.getPlan(work.planId).evidenceRefs, [alias, 'ordinary-evidence'], 'the original task facts and sourceRevision inputs remain unchanged');
});

test('unknown or pending publication references retain original report traces and create no reply result card', async t => {
  const f = await fixture(t), alias = 'tool-result://same-call', work = f.plan('a', f.owner, [alias, 'tool-result://missing']);
  await f.publish(work, { index: false });
  assert.deepEqual(f.source.projectReportEvidence(work, work.evidenceRefs), work.evidenceRefs);
  assert.deepEqual(f.source.replyReferences({ ...f.owner, sessionIds: [work.delegationOrigin.sessionId] }), []);
  f.changeOwner();
  assert.deepEqual(f.source.projectReportEvidence(work, work.evidenceRefs), work.evidenceRefs);
  assert.throws(() => f.source.replyReferences({ ...f.owner, sessionIds: [work.delegationOrigin.sessionId] }), { code: 'interactive_scope_denied' });
});

test('report and reply references remain pinned to their actual versions after head advances and an unchanged call retains original identity', async t => {
  const f = await fixture(t), work = f.plan('a', f.owner, ['tool-result://same-call', 'tool-result://revision']);
  const first = await f.publish(work);
  const revision = await f.publish(work, { call: 'revision', candidate: { ...f.draft, title: 'New fixed trial',
    publication: { kind: 'revise', base: first.reference } } });
  assert.notEqual(revision.reference.contentVersion, first.reference.contentVersion);
  assert.deepEqual(f.source.projectReportEvidence(work, work.evidenceRefs), [first.evidenceRef, revision.evidenceRef]);
  assert.deepEqual(f.source.replyReferences({ ...f.owner, sessionIds: [work.delegationOrigin.sessionId] }), [first.evidenceRef, revision.evidenceRef]);
  const nextWork = f.plan('b', f.owner, ['tool-result://same-call']);
  const unchanged = await f.publish(nextWork, { candidate: { ...f.draft, title: 'New fixed trial', publication: { kind: 'revise', base: revision.reference } } });
  assert.equal(unchanged.unchanged, true);
  assert.deepEqual(f.source.projectReportEvidence(nextWork, nextWork.evidenceRefs), [revision.evidenceRef]);
  assert.deepEqual(f.source.replyReferences({ ...f.owner, sessionIds: [nextWork.delegationOrigin.sessionId] }), [revision.evidenceRef]);
});

test('reply references are bounded without shortening the complete report or skipping ownership checks of later cited sessions', async t => {
  const f = await fixture(t), aliases = Array.from({ length: 21 }, (_, i) => `tool-result://call-${i}`), work = f.plan('a', f.owner, aliases), receipts = [];
  for (let i = 0; i < aliases.length; i++) receipts.push(await f.publish(work, { call: `call-${i}` }));
  const all = receipts.map(row => row.evidenceRef);
  assert.deepEqual(f.source.projectReportEvidence(work, aliases), all);
  assert.deepEqual(f.source.replyReferences({ ...f.owner, sessionIds: [work.delegationOrigin.sessionId] }), all.slice(0, 20));
  const foreign = f.plan('foreign', { workspaceId: 'other-bot', conversationId: 'other-parent' });
  assert.throws(() => f.source.replyReferences({ ...f.owner, sessionIds: [work.delegationOrigin.sessionId, foreign.delegationOrigin.sessionId] }), { code: 'interactive_scope_denied' });
});
