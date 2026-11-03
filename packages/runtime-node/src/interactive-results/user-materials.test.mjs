import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createConversationStore } from '../../../conversation-store/src/index.mjs';
import { createGoalPlanStore } from '../goal-plan-store.mjs';
import { resolveWorkSessionProfile } from '../project-agent/work-session-profile.mjs';
import { createInteractiveRuntime } from './runtime.mjs';

test('canonical inline uploads produce scoped version references and immutable published bytes without tool Evidence or file reads', async t => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'peer-interactive-upload-')));
  const conversations = createConversationStore({ storeDir: path.join(root, 'conversations') });
  const parent = conversations.createConversation({ role: 'project_agent', workspaceId: 'bot-a' });
  const child = conversations.createConversation({ role: 'work_session', workspaceId: 'bot-a' });
  const plans = createGoalPlanStore({ storeDir: path.join(root, 'goals') });
  const model = { providerId: 'test', modelId: 'test', modelProviderId: 'test', family: 'test' };
  const plan = plans.createPlan({ planId: 'plan-a', conversationId: child.id, title: 'Compare uploaded estimates', tasks: [], delegationOrigin: {
    workspaceId: 'bot-a', parentConversationId: parent.id, sessionId: 'session-a', readOnly: true, phase: 'running', anchorMessageId: 'anchor-a', inputId: 'input-a',
    modelSelection: { worker: model, explorer: model, verifier: model, source: { worker: 'global' }, resolvedAt: '2026-11-03T00:00:00Z' } } });
  let dataLevel = 'D4_regulated';
  const runtime = createInteractiveRuntime({ rootDir: path.join(root, 'runtime'), goalPlanStore: plans, conversationStore: conversations,
    getBotConversationId: () => parent.id, enabled: () => true, holdsLease: () => true, classifyContext: () => dataLevel });
  t.after(() => { runtime.close(); rmSync(root, { recursive: true, force: true }); });
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
  assert.equal(JSON.stringify(runtime.resultStore.readMaterial(original.reference.owner, notices[0].source)).includes('must-not-be-stored'), false);
  dataLevel = 'D3_private';
  assert.equal(runtime.userMaterialNotices(context)[0].dataLevel, 'D4_regulated', 'a saved source cannot be downgraded by a less strict later context');
  conversations.updateMessageById(child.id, message.id, { attachments: [{ ...upload, text: '{"rows":[{"id":0,"cost":999}]}', size: 30 }] });
  const changed = runtime.userMaterialNotices(context)[0];
  assert.notEqual(changed.source.expectedContentVersion, notices[0].source.expectedContentVersion);
  assert.deepEqual(runtime.resultStore.getVersion(original.reference).content.bindings.facts, rows);
  assert.equal((await publish('new-version', changed.source)).result.status, 'success');
  assert.equal((await publish('retain-original')).result.status, 'success');
  assert.deepEqual(approvals, [{ id: 'publish-a', dataLevel: 'D4_regulated' }, { id: 'new-version', dataLevel: 'D4_regulated' }, { id: 'retain-original', dataLevel: 'D4_regulated' }]);
  const denied = await publish('foreign-material', { ...notices[0].source, messageId: 'foreign-message' });
  assert.equal(denied.result.outputPreview.reason, 'material_scope_denied');
  conversations.updateMessageById(child.id, message.id, { attachments: [] });
  assert.deepEqual(runtime.userMaterialNotices(context), []);
  assert.equal((await publish('withdrawn-material')).result.outputPreview.reason, 'material_scope_denied');
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
