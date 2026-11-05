import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createConversationStore } from '../../../conversation-store/src/index.mjs';
import { readStoredWorkHistory } from '../../../conversation-store/src/persisted-history.mjs';
import { createGoalPlanStore } from '../goal-plan-store.mjs';
import { resolveWorkSessionProfile } from '../project-agent/work-session-profile.mjs';
import { createInteractiveRuntime } from './runtime.mjs';
import { createInteractiveViewService } from './view-service.mjs';
import { createInteractiveResultStore as createLegacyStore } from './test-fixtures/retention-legacy-store.mjs';

test('canonical inline uploads produce scoped version references and immutable published bytes without tool Evidence or file reads', async t => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'peer-interactive-upload-')));
  const conversationDir = path.join(root, 'conversations');
  const conversations = createConversationStore({ storeDir: conversationDir });
  const parent = conversations.createConversation({ role: 'project_agent', workspaceId: 'bot-a' });
  conversations.appendMessage(parent.id, { id: 'anchor-a', role: 'user', kind: 'user_input', content: 'Compare the captured estimates' });
  const child = conversations.createChildConversation({ parentConversationId: parent.id, role: 'work_session', workspaceId: 'bot-a', anchorMessageId: 'anchor-a',
    delegation: { sessionId: 'session-a', anchorMessageId: 'anchor-a', inputId: 'input-a' }, backgroundMessageIds: ['anchor-a'],
    runtimeState: { conversationId: parent.id, contentRevision: conversations.getPersistedConversationHistory(parent.id).contentRevision, status: 'idle' },
    capturedAt: '2026-11-03T00:00:00Z' });
  const plans = createGoalPlanStore({ storeDir: path.join(root, 'goals') });
  const model = { providerId: 'test', modelId: 'test', modelProviderId: 'test', family: 'test' };
  const plan = plans.createPlan({ planId: 'plan-a', conversationId: child.id, title: 'Compare uploaded estimates', tasks: [], delegationOrigin: {
    workspaceId: 'bot-a', parentConversationId: parent.id, sessionId: 'session-a', readOnly: true, phase: 'running', anchorMessageId: 'anchor-a', inputId: 'input-a',
    modelSelection: { worker: model, explorer: model, verifier: model, source: { worker: 'global' }, resolvedAt: '2026-11-03T00:00:00Z' } } });
  let dataLevel = 'D4_regulated';
  const runtime = createInteractiveRuntime({ rootDir: path.join(root, 'runtime'), goalPlanStore: plans, conversationStore: conversations,
    readPortableWorkHistory: (scope, budget) => readStoredWorkHistory(conversationDir, scope, budget),
    getBotConversationId: () => parent.id, enabled: () => true, holdsLease: () => true, classifyContext: () => dataLevel });
  const owner = { workspaceId: 'bot-a', conversationId: parent.id };
  const views = createInteractiveViewService({ resultStore: runtime.resultStore, stateStore: runtime.stateStore,
    readSourceIssues: runtime.readSourceIssues, resolveSource: () => ({ owner, assertCurrent: () => true }) });
  t.after(() => { views.dispose(); runtime.close(); rmSync(root, { recursive: true, force: true }); });
  async function readView(reference) {
    const sender = new EventEmitter();
    try {
      const view = await views.open(sender, { reference, requestId: 'material-view' });
      assert.equal(view.ok, true, JSON.stringify(view));
      return view;
    } finally { sender.emit('destroyed'); }
  }
  const rows = Array.from({ length: 200 }, (_, id) => ({ id, label: `row-${id}`, cost: id + 1 }));
  const text = JSON.stringify({ rows, password: 'must-not-be-stored' });
  const upload = { id: 'upload-a', sourceKind: 'user_upload', kind: 'text', mimeType: 'application/json', name: 'estimates.json', size: Buffer.byteLength(text), text };
  const message = { id: 'user-a', role: 'user', createdAt: '2026-11-03T00:01:00Z', content: 'Compare', attachments: [upload] };
  conversations.appendMessage(child.id, message);
  const context = { conversationId: child.id, workspaceId: 'bot-a', turnProfile: resolveWorkSessionProfile({ plan, kind: 'worker' }) };
  const notices = runtime.userMaterialNotices(context);
  assert.equal(notices.length, 1); assert.equal(notices[0].source.kind, 'user-material');
  assert.equal(notices[0].redacted, true); assert.equal(notices[0].dataLevel, 'D4_regulated');
  assert.deepEqual(notices[0].selectorRoots, ['text', 'json']);
  assert.equal(runtime.resultStore.storage.connect('bot-a'), null, 'context reference assembly has no publication store write');
  assert.deepEqual(runtime.userMaterialNotices({ ...context, turnProfile: resolveWorkSessionProfile({ plan, kind: 'verifier' }) }), []);
  const approvals = [];
  const publish = (id, source = notices[0].source) => runtime.provider.executeCapability({ call: { toolCallId: id, capabilityId: 'local.interactive.publish', arguments: {
    publication: { kind: 'create' }, title: 'Uploaded estimates', textFallback: 'User-provided estimates, no business verification.',
    program: 'root=Metric("Total",@Total(@Data("facts"),"cost"))', inputs: [{ bindingId: 'facts', source, selector: { path: ['json', 'rows'] } }],
  } } }, { toolContext: context, requestPermission: async request => {
    approvals.push({ id, dataLevel: request.dataLevel }); assert.equal(request.scope.dataLevel, request.dataLevel);
    if (id === 'publish-a') assert.equal(runtime.resultStore.storage.connect('bot-a'), null, 'classification is read-only before approval');
    return { granted: true };
  } });
  const result = await publish('publish-a');
  assert.equal(result.result.status, 'success', JSON.stringify(result.result.outputPreview));
  const original = runtime.resultStore.getVersion(result.result.outputPreview.reference);
  assert.deepEqual(original.content.bindings.facts, rows);
  assert.equal(original.dataLevel, 'D4_regulated');
  assert.deepEqual(original.provenance[0].evidenceRefs, []);
  assert.equal(original.provenance[0].observedAt, message.createdAt);
  const material = runtime.resultStore.readMaterialInfo(owner, notices[0].source);
  assert.deepEqual(material.origin, { conversationId: child.id, planId: 'plan-a', sessionId: 'session-a' });
  const legacyStore = createLegacyStore({ rootDir: path.join(root, 'runtime'), assertCompatibility: () => true });
  try { assert.deepEqual(legacyStore.readMaterial(owner, notices[0].source).value.json.rows, rows); }
  finally { legacyStore.close(); }
  assert.equal((await readView(original.reference)).sourceIssues, undefined);
  assert.equal(JSON.stringify(runtime.resultStore.readMaterial(original.reference.owner, notices[0].source)).includes('must-not-be-stored'), false);
  dataLevel = 'D3_private';
  assert.equal(runtime.userMaterialNotices(context)[0].dataLevel, 'D4_regulated', 'a saved source cannot be downgraded by a less strict later context');
  conversations.updateMessageById(child.id, message.id, { attachments: [{ ...upload, text: '{"rows":[{"id":0,"cost":999}]}', size: 30 }] });
  const changed = runtime.userMaterialNotices(context)[0];
  assert.notEqual(changed.source.expectedContentVersion, notices[0].source.expectedContentVersion);
  assert.deepEqual(runtime.resultStore.getVersion(original.reference).content.bindings.facts, rows);
  const stale = await readView(original.reference);
  assert.deepEqual(stale.sourceIssues, [{ bindingId: 'facts', status: 'source_changed' }]);
  assert.deepEqual(stale.result.content.bindings.facts, rows);
  assert.equal((await publish('new-version', changed.source)).result.status, 'success');
  assert.equal((await publish('retain-original')).result.status, 'success');
  assert.deepEqual(approvals, [{ id: 'publish-a', dataLevel: 'D4_regulated' }, { id: 'new-version', dataLevel: 'D4_regulated' }, { id: 'retain-original', dataLevel: 'D4_regulated' }]);
  const denied = await publish('foreign-material', { ...notices[0].source, messageId: 'foreign-message' });
  assert.equal(denied.result.outputPreview.reason, 'material_scope_denied');
  conversations.updateMessageById(child.id, message.id, { attachments: [] });
  assert.deepEqual(runtime.userMaterialNotices(context), []);
  assert.equal((await publish('withdrawn-material')).result.outputPreview.reason, 'material_scope_denied');
  const removed = await readView(original.reference);
  assert.deepEqual(removed.sourceIssues, [{ bindingId: 'facts', status: 'attachment_removed' }]);
  assert.deepEqual(removed.result.content.bindings.facts, rows);

  const laterOrigin = { conversationId: 'later-worker', planId: 'later-plan', sessionId: 'later-session' };
  const inherited = { ...original, source: { ...original.source, ...laterOrigin } };
  assert.deepEqual(runtime.readSourceIssues(inherited), removed.sourceIssues, 'a later publication cannot replace the material origin');
  const { value, ...saved } = runtime.resultStore.readMaterial(owner, notices[0].source);
  runtime.resultStore.recordMaterial({ ...saved, value, origin: laterOrigin }, () => true);
  assert.deepEqual(runtime.resultStore.readMaterialInfo(owner, notices[0].source), material, 'a retry cannot rebind the original location');

  conversations.appendMessage(child.id, { id: 'long-history', role: 'assistant', content: 'x'.repeat(8 * 1024 * 1024) });
  const limited = await readView(original.reference);
  assert.deepEqual(limited.sourceIssues, [{ bindingId: 'facts', status: 'source_unavailable' }]);
  assert.deepEqual(limited.result.content.bindings.facts, rows, 'a history over the source budget must not make the saved result unavailable');
  conversations.updateMessageById(child.id, 'long-history', { content: 'short again' });
  assert.deepEqual((await readView(original.reference)).sourceIssues, removed.sourceIssues);

  const db = runtime.resultStore.storage.connect(owner.workspaceId).db;
  db.prepare("UPDATE materials SET metadata=json_remove(metadata,'$.origin') WHERE json_extract(metadata,'$.contentVersion')=?").run(material.contentVersion);
  const legacy = await readView(original.reference);
  assert.deepEqual(legacy.sourceIssues, [{ bindingId: 'facts', status: 'source_unavailable' }]);
  assert.deepEqual(legacy.result.content.bindings.facts, rows);
  assert.deepEqual(runtime.resultStore.getVersion(original.reference), original, 'source status never rewrites fixed content');
});

test('missing observation time, unsupported upload types and forged source kinds are not advertised as canonical materials', () => {
  const plan = { planId: 'p', conversationId: 'child', createdAt: '2026-11-03T00:00:00Z', delegationOrigin: {
    workspaceId: 'bot', parentConversationId: 'parent', sessionId: 's', phase: 'running' } };
  const original = { id: 'u', role: 'user', attachments: [{ id: 'a', kind: 'text', sourceKind: 'user_upload', text: 'text', size: 4 }] };
  let message = original;
  const runtime = createInteractiveRuntime({ goalPlanStore: { getPlan: () => plan }, conversationStore: {
    getPersistedConversationHistory: () => ({ messages: [message] }),
  }, getBotConversationId: () => 'parent', enabled: () => true, holdsLease: () => true, classifyContext: () => 'D3_private' });
  try {
    const context = { conversationId: 'child', workspaceId: 'bot', turnProfile: resolveWorkSessionProfile({ plan, kind: 'worker' }) };
    for (const invalid of [original, { ...original, createdAt: plan.createdAt, attachments: [{ ...original.attachments[0], sourceKind: 'model_data' }] },
      { ...original, createdAt: plan.createdAt, attachments: [{ ...original.attachments[0], kind: 'unsupported' }] }]) {
      message = invalid; assert.deepEqual(runtime.userMaterialNotices(context), []);
    }
  }
  finally { runtime.close(); }
});
