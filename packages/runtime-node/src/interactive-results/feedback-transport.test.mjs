import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { validateDraft } from '@peer-agent/interactive-content';
import { interactiveFeedbackFromFollowup, followupFromInteractiveFeedback, interactiveFeedbackAttachment, readInteractiveFeedbackAttachment,
  normalizeResourceFeedback, encodeResourceFeedbackTransport, restoreResourceFeedbackTransport, isInteractiveFeedbackAttachment } from '@peer-agent/protocol';
import { createConversationStore } from '../../../conversation-store/src/index.mjs';
import { createInteractiveResultStore } from './store.mjs';
import { createInteractiveRetention, INTERACTIVE_RETENTION_SOURCES } from './retention.mjs';
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
  const parent = conversations.createConversation({ title: 'Original Bot', role: 'project_agent', workspaceId: 'bot-a' }), owner = { workspaceId: 'bot-a', conversationId: parent.id };
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
  const admission = createInteractiveFeedbackAdmission({ stateStore: states, conversationStore: conversations }), options = { rootDir, resolveConversationId: () => owner.conversationId,
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
  // These blocks are from 8b3ffbcf, whose complete Conversation source was pinned
  // before the independent metadata and asynchronous terminal lock changes.
  // The isEmptyUserMessage writer block now assigns the index preview in the same
  // successful append/update/replace, and writes that index through writeIndex so
  // the list cache drops. Message JSONL bytes are unchanged: the assertions above
  // already require the attachment text to survive rewrite and reopen. The new
  // digest covers that index preview, not a new message shape.
  const code = readFileSync(new URL('../../../conversation-store/src/index.mjs', import.meta.url), 'utf8');
  const pinnedWriterBlocks = [
    ['function readJsonl(', '\nfunction readJson(', 'f943550e04e210417ac7615ceb2facfcbe46757d58b6fe4b5743e8dd70cb65c0'],
    ['function normalizeMeta(', '\n// 一次性数据迁移', 'f6517a5371f61f887e3b58dc22292a5edfc33a27484e87adcea9f9024c955060'],
    ['  function isEmptyUserMessage(', '\n  const terminalCommitter', 'a361fd9fc24b51a70792f30424e56606f431826233c9b24ce02ca28fcd3ed768'],
    ['  const messageWrite =', '\n\n  // 会话级累计用量账本', '627b6d84b4d011357a67384253575c7a8b431870939ec233765c53f3ca9af693'],
    ['    appendMessage: changed(', '\n    commitStreamingMessage:', 'a9b2e4fe91f3d89e7eb0ec8755502ac46e9b17cf90c9feb595b90e06050a5c98'],
    ['    replaceMessages: changed(', '\n', 'af3abf6e886b6f8f9b449f80273d4a26554123f662087c934933ad279cb8ecb9'],
  ];
  for (const [begin, end, digest] of pinnedWriterBlocks) {
    const first = code.indexOf(begin);
    const last = code.indexOf(end, first);
    assert.ok(first >= 0 && last > first, `missing pinned Conversation writer block ${begin}`);
    assert.equal(createHash('sha256').update(code.slice(first, last)).digest('hex'), digest, begin);
  }
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
  // After the parent history is rewritten and the stores reopen, the actual child
  // still retains its own canonical copy. No caller-provided child list is used.
  f.conversations.replaceMessages(f.owner.conversationId, [{ ...anchor, attachments: [upload] }]);
  const reopened = createConversationStore({ storeDir: path.join(f.rootDir, 'conversations') });
  const admission = createInteractiveFeedbackAdmission({ stateStore: f.states, conversationStore: reopened });
  const guarded = admission.acquireMessageRoots(f.owner);
  try {
    assert.deepEqual(new Set(guarded.conversationIds), new Set([f.owner.conversationId, plan.conversationId]));
    assert.deepEqual(guarded.selections, [{ reference: f.reference, followupId: f.frozen.followupId }]);
    assert.equal(guarded.assertCurrent(), true);
  } finally { guarded.release(); }
  f.conversations.replaceMessages(f.owner.conversationId, [anchor]);
  const staged = reopened.createChildConversation({ parentConversationId: f.owner.conversationId, role: 'work_session',
    workspaceId: f.owner.workspaceId, anchorMessageId: anchor.id, delegation: { sessionId: 'staged', anchorMessageId: anchor.id, inputId: 'staged-input' },
    runtimeState: { conversationId: f.owner.conversationId, contentRevision: reopened.getPersistedConversationHistory(f.owner.conversationId).contentRevision, status: 'idle' },
    capturedAt: '2026-11-04T00:00:00Z', backgroundMessageIds: [anchor.id], confirmMissing: true });
  const stagedGuard = admission.acquireMessageRoots(f.owner);
  try { assert.ok(stagedGuard.conversationIds.includes(staged.id), 'a child without a plan must still be in scope'); }
  finally { stagedGuard.release(); }
  assert.throws(() => admission.acquireMessageRoots({ ...f.owner, workspaceId: 'different-bot' }), { code: 'CONVERSATION_RETENTION_SCOPE_INVALID' });

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
test('canonical message retention pins confirmed carriers in the full durable history and excludes sidecar-only content', async t => {
  const f = await fixture(t), id = f.owner.conversationId;
  const carrier = interactiveFeedbackAttachment(f.feedback);
  const child = f.conversations.createConversation({ title: 'Second guarded conversation' });
  const conversationModule = new URL('../../../conversation-store/src/index.mjs', import.meta.url).href;
  f.conversations.appendMessage(id, { id: 'streaming', role: 'assistant', content: 'working' });
  f.conversations.appendMessage(id, { id: 'user-selection', role: 'user', content: '', attachments: [carrier] });
  f.conversations.appendMessage(child.id, { id: 'provisional', role: 'assistant', content: 'working' });
  f.conversations.patchStreamingMessage(id, 'streaming', { content: 'provisional' });
  f.conversations.patchStreamingMessage(child.id, 'provisional', { attachments: [carrier] });
  assert.equal(f.conversations.getPersistedConversationHistory(id).messages.length, 0);
  assert.throws(() => f.admission.acquireMessageRoots(f.owner, [child.id]), /interactive_retention_unavailable/);
  assert.throws(() => f.admission.acquireMessageRoots(f.owner, [id, 'missing']), /CONVERSATION_RETENTION_MISSING/);
  const guard = f.admission.acquireMessageRoots(f.owner, [id, child.id]);
  try {
    assert.deepEqual(guard.selections, [{ reference: f.reference, followupId: f.frozen.followupId }]);
    assert.match(guard.revision, /^sha256:[a-f0-9]{64}$/);
    assert.throws(() => f.admission.acquireMessageRoots(f.owner, [id]), /CONVERSATION_RETENTION_BUSY/);
    const script = `import { createConversationStore } from ${JSON.stringify(conversationModule)};
      const [storeDir, id, childId] = JSON.parse(process.argv[1]);
      const store = createConversationStore({ storeDir });
      const now = Date.now; let offset = 0;
      Date.now = () => now() + (offset += 5100);
      const row = { id: 'new', role: 'user', content: 'queued' };
      for (const operation of [() => store.appendMessage(id, row), () => store.replaceMessages(childId, [row])]) {
        try { operation(); console.log('wrote'); } catch (error) { console.log(error.code); }
      }`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script,
      JSON.stringify([path.join(f.rootDir, 'conversations'), id, child.id])], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'EEXIST\nEEXIST');
    assert.equal(guard.assertCurrent(), true);
  } finally { guard.release(); }
  assert.equal(guard.assertCurrent(), false);
  assert.equal(f.conversations.appendMessage(id, { id: 'unblocked', role: 'user', content: 'now' }).messages.length, 3);
  const file = path.join(f.rootDir, 'conversations', id + '.jsonl');
  appendFileSync(file, '{\n');
  assert.throws(() => f.admission.acquireMessageRoots(f.owner, [id]), /CONVERSATION_RETENTION_CORRUPT/);
  const invalid = { ...carrier, text: carrier.text.replace('peer-interactive-selection-1', 'peer-interactive-selection-9') };
  f.conversations.replaceMessages(id, [{ id: 'replacement', role: 'user', content: 'unsafe', attachments: [invalid] }]);
  assert.throws(() => f.admission.acquireMessageRoots(f.owner, [id]), { code: 'INTERACTIVE_FEEDBACK_TRANSPORT_INCOMPATIBLE' });
  assert.equal(f.conversations.replaceMessages(id, [{ id: 'replacement', role: 'user', content: 'safe' }]).messages.length, 1);
});

test('draft retention pins typed and legacy-carried selections while old writers respect every surface lock', async t => {
  const f = await fixture(t);
  const drafts = createProjectInputDraftStore({ rootDir: f.rootDir, validateInteractiveFeedback: f.admission.validate });
  const old = createLegacyDrafts({ rootDir: f.rootDir });
  const carrier = interactiveFeedbackAttachment(f.feedback);
  const base = { workspaceId: f.owner.workspaceId, revision: 0, draft: { text: '', quote: null, attachmentIds: [] }, pending: [], uploads: [] };
  const legacy = { ...base, surface: 'tui', uploads: [carrier], draft: { ...base.draft, attachmentIds: [carrier.id] } };
  const typed = { ...base, surface: 'desktop', pending: [{ inputId: 'queued', text: '', createdAt: '2026-11-04T00:00:00Z',
    resourceFeedback: [f.feedback], quoteRefs: [], attachmentIds: [] }] };
  assert.equal(old.write(legacy).ok, true);
  assert.equal(drafts.write(typed).ok, true);
  const folder = path.join(f.rootDir, f.owner.workspaceId, 'input-drafts');
  const guard = drafts.acquireRetentionDrafts(f.owner.workspaceId);
  try {
    assert.deepEqual(guard.selections, Array.from({ length: 2 }, () => ({ reference: f.reference, followupId: f.frozen.followupId })));
    assert.match(guard.revision, /^sha256:[a-f0-9]{64}$/);
    assert.throws(() => drafts.acquireRetentionDrafts(f.owner.workspaceId), /DRAFT_BUSY/);
    const script = `import { createProjectInputDraftStore } from ${JSON.stringify(new URL('./test-fixtures/legacy-input-draft-store.mjs', import.meta.url).href)};
      const [rootDir, base] = JSON.parse(process.argv[1]);
      const drafts = createProjectInputDraftStore({ rootDir });
      console.log(JSON.stringify(['desktop', 'quick_chat', 'tui'].map(surface => drafts.write({ ...base, surface }))));`;
    // The pinned draft writer does not steal a live PID lock after its stale interval.
    const past = new Date(Date.now() - 60_000);
    for (const surface of ['desktop', 'quick_chat', 'tui']) utimesSync(path.join(folder, surface + '.json.lock'), past, past);
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify([f.rootDir, base])], { encoding: 'utf8', timeout: 5000 });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), Array.from({ length: 3 }, () => ({ ok: false, code: 'DRAFT_BUSY' })));
    assert.equal(guard.assertCurrent(), true);
    assert.deepEqual(drafts.write({ ...base, surface: 'quick_chat' }), { ok: false, code: 'DRAFT_BUSY' });
    writeFileSync(path.join(folder, 'tui.json'), '{');
    assert.equal(guard.assertCurrent(), false);
  } finally { guard.release(); }
  assert.equal(guard.assertCurrent(), false);
  assert.throws(() => drafts.acquireRetentionDrafts(f.owner.workspaceId), /DRAFT_UNAVAILABLE/);
  assert.equal(old.write({ ...base, surface: 'quick_chat' }).ok, true, 'failed acquisition released every preceding surface');
});

test('current input queue retention pins a consumed carrier, protects the actual writer lock and rejects a truncated queue', async t => {
  const f = await fixture(t), queue = createInputQueue({ ...f.options, validateInteractiveFeedback: f.admission.validate });
  queue.submitInput(f.input('retained'));
  queue.consume(f.owner.workspaceId);
  const workspace = path.join(f.rootDir, f.owner.workspaceId), file = path.join(workspace, 'input-queue.jsonl');
  const before = readFileSync(file, 'utf8'), cursor = readFileSync(path.join(workspace, 'input-cursor.json'), 'utf8');
  const guard = queue.acquireRetentionInputs(f.owner.workspaceId);
  try {
    assert.deepEqual(guard.selections, [{ reference: f.reference, followupId: f.frozen.followupId }]);
    assert.throws(() => queue.acquireRetentionInputs(f.owner.workspaceId), { code: 'EEXIST' });
    const old = new Date(Date.now() - 60_000);
    utimesSync(file + '.lock', old, old);
    const script = `import { createInputQueue } from ${JSON.stringify(new URL('../project-agent/input-queue.mjs', import.meta.url).href)};
      const [rootDir, workspaceId] = JSON.parse(process.argv[1]);const now=Date.now;let offset=0;Date.now=()=>now()+(offset+=1000);
      try { createInputQueue({rootDir}).submitInput({workspaceId,inputId:'concurrent',surface:'tui',text:'test'});console.log('wrote'); }
      catch(error){console.log(error.code);}`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify([f.rootDir, f.owner.workspaceId])], { encoding: 'utf8', timeout: 5000 });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), 'EEXIST');
    assert.equal(guard.assertCurrent(), true);
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.equal(readFileSync(path.join(workspace, 'input-cursor.json'), 'utf8'), cursor);
    writeFileSync(file, before.trimEnd());
    assert.equal(guard.assertCurrent(), false);
  } finally { guard.release(); }
  assert.throws(() => queue.acquireRetentionInputs(f.owner.workspaceId), /CORRUPT_INPUT_QUEUE/);
  writeFileSync(file, before);
  assert.equal(queue.submitInput(f.input('after', { resourceFeedback: undefined })).inputId, 'after');
});

test('the pinned input queue writer can reclaim an aged lock despite a live PID', async t => {
  const f = await fixture(t), old = createLegacyQueue(f.options);
  old.submitInput(f.input('prior', { resourceFeedback: undefined }));
  const lock = path.join(f.rootDir, f.owner.workspaceId, 'input-queue.jsonl.lock');
  const guard = createInputQueue(f.options).acquireRetentionInputs(f.owner.workspaceId);
  try {
    const past = new Date(Date.now() - 60_000);
    utimesSync(lock, past, past);
    old.submitInput(f.input('after-reclaim', { resourceFeedback: undefined }));
    assert.equal(existsSync(lock), false);
    assert.equal(guard.assertCurrent(), false);
    assert.throws(() => createInputQueue(f.options).acquireRetentionInputs(f.owner.workspaceId), { code: 'EEXIST' });
    assert.equal(old.findSubmission(f.owner.workspaceId, 'after-reclaim').inputId, 'after-reclaim');
  } finally { guard.release(); }
});

test('an old queue writer reclaiming a live guard before commit rolls back result retirement', async t => {
  const f = await fixture(t);
  const queue = createInputQueue(f.options), legacy = createLegacyQueue(f.options);
  const lock = path.join(f.rootDir, f.owner.workspaceId, 'input-queue.jsonl.lock');
  f.states.release({ reference: f.reference, identity: f.identity, writer: f.writer }, () => true);
  const retention = createInteractiveRetention({ resultStore: f.results, stateStore: f.states, assertOwner: () => true,
    acquireRoots() {
      const guard = queue.acquireRetentionInputs(f.owner.workspaceId);
      const sources = Object.fromEntries(INTERACTIVE_RETENTION_SOURCES.map(source => [source, guard.revision]));
      return { sources, pins: [], followupIds: [], assertCurrent: guard.assertCurrent, release: guard.release };
    },
    onStep(step) {
      if (step !== 'cleanup_before_commit') return;
      const past = new Date(Date.now() - 60_000);
      utimesSync(lock, past, past);
      legacy.submitInput(f.input('concurrent-old-input', { resourceFeedback: undefined }));
    } });
  const preview = retention.preview(f.reference);
  assert.deepEqual(preview.blockers, []);
  assert.throws(() => retention.cleanup({ reference: f.reference, requestId: 'cleanup-race',
    expectedDigest: preview.cleanupDigest }), { code: 'interactive_retention_stale' });
  assert.equal(legacy.findSubmission(f.owner.workspaceId, 'concurrent-old-input').inputId, 'concurrent-old-input');
  assert.equal(retention.readTombstone(f.reference), null);
  assert.equal(f.results.getVersion(f.reference).content.title, 'Trial');
  assert.equal(f.states.read(f.reference, () => true).values.$x, 4);
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
