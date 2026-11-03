import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { validateDraft } from '@peer-agent/interactive-content';
import { interactiveFeedbackFromFollowup, followupFromInteractiveFeedback, interactiveFeedbackAttachment, readInteractiveFeedbackAttachment,
  normalizeResourceFeedback, encodeResourceFeedbackTransport, restoreResourceFeedbackTransport, isInteractiveFeedbackAttachment } from '@peer-agent/protocol';
import { createConversationStore } from '../../../conversation-store/src/index.mjs';
import { createInteractiveResultStore } from './store.mjs';
import { createInteractiveStateStore } from './state-store.mjs';
import { createInteractiveFeedbackAdmission } from './feedback-admission.mjs';
import { createInputQueue } from '../project-agent/input-queue.mjs';
import { createProjectInputDraftStore } from '../project-agent/input-draft-store.mjs';
import { createSessionSupervisor, resourceFeedbackFromMessages } from '../project-agent/session-supervisor.mjs';
import { createGoalPlanStore } from '../goal-plan-store.mjs';
import { createInteractiveAuthority } from './authority.mjs';
import { executionIdentity } from '../project-agent/session-control-kernel.mjs';
import { createInputQueue as createLegacyQueue } from './test-fixtures/legacy-input-queue.mjs';
import { createProjectInputDraftStore as createLegacyDrafts } from './test-fixtures/legacy-input-draft-store.mjs';
import { normalizeResourceFeedbackList as normalizeLegacyFeedback } from './test-fixtures/legacy-resource-feedback.mjs';

const upload = { id: 'user-file', name: 'brief.txt', mimeType: 'text/plain', size: 4, sourceKind: 'user_upload', kind: 'text', text: 'keep' };
async function fixture(t) {
  const rootDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'peer-interactive-feedback-'))), conversations = createConversationStore({ storeDir: path.join(rootDir, 'conversations') });
  const parent = conversations.createConversation({ title: 'Original Bot' }), owner = { workspaceId: 'bot-a', conversationId: parent.id };
  const results = createInteractiveResultStore({ rootDir, assertCompatibility: () => true }), states = createInteractiveStateStore({ resultStore: results });
  t.after(() => { states.close(); results.close(); rmSync(rootDir, { recursive: true, force: true }); });
  const draft = { publication: { kind: 'create' }, title: 'Trial', textFallback: 'Unverified trial.', inputs: [],
    program: '$x=2\n$name="Trial"\nroot=Col([Input("name","Trial name",$name),NumberInput("x","Divisor",$x,1,10,1),Metric("Ratio",10/$x)])' };
  const receipt = results.commitPublication({ owner, source: { conversationId: 'worker', planId: 'plan', sessionId: 'session', toolCallId: 'publish', executionEpoch: 'epoch' },
    draft, content: await validateDraft(draft), provenance: [], dataLevel: 'D3_private', grant: { toolCallId: 'publish', grantId: 'fixture', granted: true } }, () => true);
  results.markIndexed(receipt.callRef, receipt.indexEntry);
  const identity = { viewId: 'view', windowId: 'window', generation: 'generation' }, reference = receipt.reference;
  const writer = states.acquire({ reference, identity, expectedRevision: 0 }, () => true);
  const saved = states.save({ reference, identity, writer, expectedRevision: 0, requestId: 'save-1', values: { $x: 4, $name: '固定条件' }, inputDrafts: {} }, () => true);
  const frozen = await states.prepareFollowup({ reference, identity, writer, stateRevision: saved.stateRevision, stateDigest: saved.stateDigest, fields: ['$x', '$name'], requestId: 'followup-1' }, () => true);
  const feedback = interactiveFeedbackFromFollowup(frozen); assert.ok(feedback);
  const admission = createInteractiveFeedbackAdmission({ stateStore: states }), options = { rootDir, resolveConversationId: () => owner.conversationId,
    holdsLease: () => true, hasMessage: (_conversation, id) => conversations.getConversation(parent.id).messages.some(message => message.id === id),
    appendMessage: (conversation, message) => conversations.appendMessage(conversation, message) };
  return { rootDir, conversations, owner, results, states, feedback, frozen, admission, options, reference, identity, writer,
    input: (inputId, extra = {}) => ({ workspaceId: owner.workspaceId, surface: 'desktop', inputId, text: 'Discuss these conditions', resourceFeedback: [feedback], ...extra }) };
}
test('the logical contract binds every selected value, revision, owner and receipt without a path or authority field', async t => {
  const f = await fixture(t);
  assert.equal(f.admission.validate(f.feedback, f.owner.workspaceId), true);
  assert.deepEqual(followupFromInteractiveFeedback(f.feedback), { ...f.frozen, values: { $name: '固定条件', $x: 4 } });
  const body = interactiveFeedbackAttachment(f.feedback);
  assert.deepEqual(readInteractiveFeedbackAttachment({ text: body.text, kind: body.kind, ...body }), f.feedback);
  assert.equal(body.filePath, undefined); assert.equal(body.size, Buffer.byteLength(body.text));
  assert.equal(normalizeLegacyFeedback([f.feedback]), undefined, 'the pinned normalizer really cannot retain the new union');
  for (const patch of [{ id: 'another' }, { recipient: { ...f.owner, conversationId: 'another' } }, { selection: { kind: 'discussion' } }, { permissionGrant: true }]) {
    assert.equal(normalizeResourceFeedback({ ...f.feedback, ...patch }), undefined);
  }
  const forged = { ...f.feedback, version: { ...f.feedback.version, values: { $name: '固定条件', $x: 9 } } };
  assert.throws(() => f.admission.validate(forged, f.owner.workspaceId), { code: 'INTERACTIVE_FEEDBACK_MISMATCH' });
  assert.equal(isInteractiveFeedbackAttachment({ ...upload, text: 'Explain this example: {"schema":"peer-interactive-selection-1"}' }), false);
});
test('known attachments carry the complete selection through a real already-open old queue, its cursor and actual Conversation rewrite/reopen', async t => {
  const f = await fixture(t), legacy = createLegacyQueue(f.options), queue = createInputQueue({ ...f.options, validateInteractiveFeedback: f.admission.validate });
  legacy.submitInput(f.input('older', { resourceFeedback: undefined })); assert.ok(legacy.findSubmission(f.owner.workspaceId, 'older'));
  const selected = queue.submitInput(f.input('selected', { attachments: [upload] }));
  assert.deepEqual(selected.resourceFeedback, [f.feedback]); assert.deepEqual(selected.attachments, [upload]);
  const file = path.join(f.rootDir, f.owner.workspaceId, 'input-queue.jsonl'), wire = JSON.parse(readFileSync(file, 'utf8').trim().split('\n').at(-1));
  assert.equal(wire.resourceFeedback, undefined); assert.equal(wire.attachments.length, 2);
  const carrier = wire.attachments.find(isInteractiveFeedbackAttachment); assert.ok(carrier);
  assert.deepEqual(readInteractiveFeedbackAttachment(carrier), f.feedback);
  legacy.submitInput(f.input('later', { resourceFeedback: undefined }));
  assert.deepEqual(legacy.consume(f.owner.workspaceId).consumed.map(input => input.inputId), ['older', 'selected', 'later']);
  assert.equal(legacy.cursor(f.owner.workspaceId), 'later');
  const message = f.conversations.getConversation(f.owner.conversationId).messages.find(message => message.inputId === 'selected');
  assert.equal(message.resourceFeedback, undefined); assert.equal(message.attachments[1].text, carrier.text);
  f.conversations.updateMessageById(f.owner.conversationId, message.id, { content: 'Updated discussion text' });
  f.conversations.replaceMessages(f.owner.conversationId, f.conversations.getConversation(f.owner.conversationId).messages);
  const reopened = createConversationStore({ storeDir: path.join(f.rootDir, 'conversations') });
  const restored = reopened.getPersistedConversationHistory(f.owner.conversationId).messages.find(row => row.id === message.id);
  assert.equal(restored.attachments[1].text, carrier.text); assert.deepEqual(f.admission.restore(restored, f.owner.workspaceId), [f.feedback]);
  f.states.save({ reference: f.reference, identity: f.identity, writer: f.writer, expectedRevision: 1, requestId: 'save-2', values: { $x: 6, $name: 'Later edit' }, inputDrafts: {} }, () => true);
  assert.equal(queue.findSubmission(f.owner.workspaceId, 'selected').resourceFeedback[0].version.values.$x, 4);
  assert.deepEqual(queue.submitInput(f.input('selected')).resourceFeedback, [f.feedback]);
  const code = readFileSync(new URL('../../../conversation-store/src/index.mjs', import.meta.url), 'utf8');
  assert.equal(createHash('sha256').update(code).digest('hex'), 'a5f25527c02bdda6917680538ae480cd57f9d80bc55f259f290c4daf630d9e5e', 'the actual shared Conversation writer must still equal the pinned source');
});
test('the pinned old queue demonstrably skips an unknown direct union, so the test cannot pass by merely adding a version marker', async t => {
  const f = await fixture(t), legacy = createLegacyQueue(f.options);
  legacy.submitInput(f.input('first', { resourceFeedback: undefined }));
  appendFileSync(path.join(f.rootDir, f.owner.workspaceId, 'input-queue.jsonl'), JSON.stringify(f.input('unsafe-direct')) + '\n');
  legacy.submitInput(f.input('after', { resourceFeedback: undefined }));
  assert.deepEqual(legacy.consume(f.owner.workspaceId).consumed.map(row => row.inputId), ['first', 'after']);
  assert.equal(legacy.cursor(f.owner.workspaceId), 'after');
});

test('actual delegation preserves wire bytes and admits the prior result only from a verified explicit user anchor', async t => {
  const f = await fixture(t), queue = createInputQueue({ ...f.options, validateInteractiveFeedback: f.admission.validate });
  queue.submitInput(f.input('selected', { attachments: [upload] })); queue.consume(f.owner.workspaceId);
  const anchor = f.conversations.getPersistedConversationHistory(f.owner.conversationId).messages[0];
  const plans = createGoalPlanStore({ storeDir: path.join(f.rootDir, 'plans') });
  const model = { modelProviderId: 'worker', providerId: 'fixture', modelId: 'fixture', family: 'fixture', tools: true, vision: true, contextTokens: 32000 };
  const supervisor = createSessionSupervisor({ conversationStore: f.conversations, goalPlanStore: plans,
    goalRunner: { async start() {}, async waitForIdle() {}, pause() {} }, deferRecovery: true,
    catalog: [model], routing: { tiers: { strong: { primary: 'worker' }, vision: { primary: 'worker' } },
      roles: { session_worker: { mode: 'tier', tier: 'strong' }, explorer: { mode: 'tier', tier: 'strong' }, verifier: { mode: 'tier', tier: 'strong' }, visual_verifier: { mode: 'tier', tier: 'vision' } }, verifierPreferDifferentFamily: false },
    readDelegationCapabilities: () => ['local.interactive.inspect'], readResourceFeedback: f.admission.restore });
  const input = { anchorMessageIds: [anchor.id], title: 'Discuss selection', brief: 'Inspect the frozen conditions', kind: 'research', readOnly: true,
    requiredCapabilities: ['local.interactive.inspect'], successCriteria: [{ id: 'checked', kind: 'manual', description: 'Conditions discussed' }] };
  const context = { parentConversationId: f.owner.conversationId, workspaceId: f.owner.workspaceId, workspacePath: f.rootDir,
    inputId: 'selected', manualCriterionAuthorities: [{ criterionId: 'checked', source: 'project_policy', sourceRef: 'fixture-policy' }] };
  const spawned = await supervisor.spawn(input, context); assert.ok(spawned.sessionId, JSON.stringify(spawned));
  const plan = plans.getPlan(supervisor.get({ sessionId: spawned.sessionId }).planId);
  const child = f.conversations.getPersistedConversationHistory(plan.conversationId).messages[0];
  assert.equal(child.resourceFeedback, undefined, 'unknown union never leaks back into shared child records');
  assert.equal(child.attachments[1].text, anchor.attachments[1].text); assert.deepEqual(child.attachments[0], upload);
  assert.deepEqual(f.admission.restore(child, f.owner.workspaceId), [f.feedback]);
  const origin = { planId: 'plan', conversationId: 'worker', delegationOrigin: { workspaceId: f.owner.workspaceId, parentConversationId: f.owner.conversationId, sessionId: 'session' } };
  const authority = createInteractiveAuthority({ goalPlanStore: { getPlan: id => id === 'plan' ? origin : plans.getPlan(id) },
    conversationStore: f.conversations, resultStore: f.results, getBotConversationId: () => f.owner.conversationId,
    holdsLease: () => true, enabled: () => true, readResourceFeedback: f.admission.restore });
  const resolved = authority.resolve({ call: { toolCallId: 'inspect' }, toolContext: { conversationId: plan.conversationId, workspaceId: f.owner.workspaceId,
    turnProfile: { role: 'work_session', agentKind: 'worker', workspaceId: f.owner.workspaceId, planId: plan.planId,
      sessionId: plan.delegationOrigin.sessionId, executionIdentity: executionIdentity(plan) } } });
  assert.equal(resolved.admitResult(f.reference), true); assert.equal(resolved.admitFollowup(f.frozen.followupId), true);
  assert.throws(() => resourceFeedbackFromMessages([anchor], [anchor.id], { recipient: f.owner }), { code: 'INTERACTIVE_FEEDBACK_UNAVAILABLE' });
  assert.deepEqual(resourceFeedbackFromMessages([{ ...anchor, role: 'assistant' }], [anchor.id], { recipient: f.owner, readResourceFeedback: f.admission.restore }), []);
  const forged = structuredClone(f.feedback); forged.version.values.$x = 9;
  f.conversations.appendMessage(f.owner.conversationId, { id: 'forged', role: 'user', content: 'changed', attachments: [interactiveFeedbackAttachment(forged)] });
  const children = f.conversations.listChildren(f.owner.conversationId, { role: 'work_session' }).length;
  const denied = await supervisor.spawn({ ...input, title: 'Forged', anchorMessageIds: ['forged'] }, { ...context, inputId: 'forged' });
  assert.equal(denied.error, 'spawn_failed'); assert.equal(denied.message, 'INTERACTIVE_FEEDBACK_MISMATCH');
  assert.equal(f.conversations.listChildren(f.owner.conversationId, { role: 'work_session' }).length, children);
});
test('format 3 fences the actual old draft writer, stays sticky after removal and preserves malformed/future records', async t => {
  const f = await fixture(t), old = createLegacyDrafts({ rootDir: f.rootDir }), drafts = createProjectInputDraftStore({ rootDir: f.rootDir, validateInteractiveFeedback: f.admission.validate });
  const address = { workspaceId: f.owner.workspaceId, surface: 'desktop' }, base = { ...address, revision: 0, draft: { text: 'keep text', quote: { messageId: 'quoted', text: 'keep quote' }, attachmentIds: ['user-file'] }, pending: [], uploads: [upload] };
  assert.equal(old.write(base).ok, true);
  assert.equal(drafts.write({ ...base, revision: 1, uploads: [], draft: { ...base.draft, resourceFeedback: [f.feedback] } }).ok, true);
  const file = path.join(f.rootDir, f.owner.workspaceId, 'input-drafts/desktop.json'), bytes = readFileSync(file, 'utf8');
  assert.equal(JSON.parse(bytes).schemaVersion, 3); assert.equal(old.read(address).ok, false);
  assert.equal(old.write({ ...base, revision: 2, uploads: [], draft: { ...base.draft, text: 'old overwrite' } }).ok, false);
  assert.equal(readFileSync(file, 'utf8'), bytes);
  const restored = drafts.read(address); assert.equal(restored.ok, true);
  assert.equal(restored.snapshot.draft.text, 'keep text'); assert.equal(restored.snapshot.draft.quote.text, 'keep quote'); assert.deepEqual(restored.snapshot.draft.attachments, [upload]);
  assert.deepEqual(restored.snapshot.draft.resourceFeedback, [f.feedback]);
  assert.equal(drafts.write({ ...base, revision: 2, uploads: [] }).ok, true);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).schemaVersion, 3);
  const saved = JSON.parse(bytes);
  for (const corrupt of [{ ...saved, schemaVersion: 999 }, { ...saved, future: true }, { ...saved, schemaVersion: 2 },
    { ...saved, draft: { ...saved.draft, resourceFeedback: [{ ...f.feedback, version: { ...f.feedback.version, values: { $x: 9 } } }] } }]) {
    writeFileSync(file, JSON.stringify(corrupt)); const before = readFileSync(file, 'utf8');
    assert.equal(drafts.read(address).ok, false); assert.equal(drafts.write({ ...base, revision: saved.revision, uploads: [] }).ok, false); assert.equal(readFileSync(file, 'utf8'), before);
  }
});
test('forgery, missing admission and corrupted transport cannot move the new consumer past the selection or clobber user attachments', async t => {
  const f = await fixture(t), queue = createInputQueue({ ...f.options, validateInteractiveFeedback: f.admission.validate });
  const missing = createInputQueue(f.options);
  assert.throws(() => missing.submitInput(f.input('unbound')), { code: 'INTERACTIVE_FEEDBACK_UNAVAILABLE' });
  assert.throws(() => queue.submitInput(f.input('full', { attachments: Array.from({ length: 8 }, (_, i) => ({ ...upload, id: `file-${i}` })) })), { code: 'RESOURCE_FEEDBACK_ATTACHMENT_LIMIT' });
  assert.equal(existsSync(path.join(f.rootDir, f.owner.workspaceId, 'input-queue.jsonl')), false);
  queue.submitInput(f.input('selected'));
  const file = path.join(f.rootDir, f.owner.workspaceId, 'input-queue.jsonl'), row = JSON.parse(readFileSync(file, 'utf8'));
  const payload = JSON.parse(row.attachments[0].text); payload.feedback.version.values.$x = 9;
  row.attachments[0] = interactiveFeedbackAttachment(payload.feedback);
  writeFileSync(file, JSON.stringify(row) + '\n');
  const legacy = createLegacyQueue(f.options); legacy.submitInput(f.input('later', { resourceFeedback: undefined }));
  const before = readFileSync(file, 'utf8');
  assert.throws(() => queue.consume(f.owner.workspaceId), { code: 'INTERACTIVE_FEEDBACK_MISMATCH' });
  assert.equal(queue.cursor(f.owner.workspaceId), null); assert.equal(f.conversations.getConversation(f.owner.conversationId).messages.length, 0); assert.equal(readFileSync(file, 'utf8'), before);
  const encoded = encodeResourceFeedbackTransport([f.feedback], [upload]);
  assert.deepEqual(restoreResourceFeedbackTransport(encoded.resourceFeedback, encoded.attachments), [f.feedback]);
});
