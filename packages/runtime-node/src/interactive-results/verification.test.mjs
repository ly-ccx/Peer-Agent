import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, realpathSync, rmSync, openSync, writeFileSync, writeSync, fsyncSync, closeSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectToolEvidenceRefs } from '@peer-agent/runtime-core';
import { interactiveFeedbackFromFollowup, encodeResourceFeedbackTransport, normalizeInteractiveInspectionReceipt, interactiveInspectionEvidenceRef } from '@peer-agent/protocol';
import { createConversationStore } from '../../../conversation-store/src/index.mjs';
import { createGoalPlanStore } from '../goal-plan-store.mjs';
import { resolveWorkSessionProfile } from '../project-agent/work-session-profile.mjs';
import { verificationContentHash } from '../project-agent/verification-completion.mjs';
import { createInteractiveRuntime } from './runtime.mjs';
import { createInteractiveRetention, INTERACTIVE_RETENTION_SOURCES } from './retention.mjs';
import { jsonDigest } from './storage.mjs';
import { normalizeTurnProfile } from '../../../../apps/desktop/electron/main/chat-runtime/turn-context.mjs';
import { normalizeEvidenceIndexRecord as legacyNormalize } from './test-fixtures/rc35-evidence-normalizer.mjs';
import { createProjectGoalRunnerHost } from '../project-agent/goal-runner-host.mjs';
import { createAgentTurnExecutor } from '../../../../apps/desktop/electron/main/agent-host/agent-turn-executor.mjs';
import { createSessionVerification } from '../project-agent/session-verification.mjs';
import { agentLoopOpenAI } from '../../../../apps/desktop/electron/main/chat-runtime/openai-agent-loop.mjs';
import { createRuntimeToolProjection, buildOpenAIToolsFromModelProjection } from '../../../../apps/desktop/electron/main/tools/index.mjs';
import { installDesktopInteractiveRuntime } from '../../../../apps/desktop/electron/main/interactive-results/runtime-port.mjs';

const PUBLISH = 'local.interactive.publish', INSPECT = 'local.interactive.inspect';
const success = evidenceRefs => ({ passed: true, evidenceRefs, failedCriteria: [], missingEvidence: [], risks: [], summary: 'Reviewed the fixed result.' });
async function fixture(t, { program, facts } = {}) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'peer-interactive-review-'))), plans = createGoalPlanStore({ storeDir: path.join(root, 'plans') });
  const conversations = createConversationStore({ storeDir: path.join(root, 'conversations') });
  const parent = conversations.createConversation({ title: 'Bot', role: 'project_agent', workspaceId: 'bot' });
  conversations.appendMessage(parent.id, { id: 'anchor', role: 'user', content: 'Compare the fixed scenarios.' });
  const parentHistory = conversations.getPersistedConversationHistory(parent.id);
  const child = conversations.createChildConversation({ parentConversationId: parent.id, role: 'work_session', anchorMessageId: 'anchor',
    delegation: { sessionId: 'session', anchorMessageId: 'anchor', inputId: 'input' },
    runtimeState: { conversationId: parent.id, contentRevision: parentHistory.contentRevision, status: 'idle' }, capturedAt: new Date().toISOString(),
    backgroundMessageIds: ['anchor'], confirmMissing: true, title: 'Worker', workspaceId: 'bot' });
  const owner = { workspaceId: 'bot', conversationId: parent.id };
  const model = { modelProviderId: 'fixture', providerId: 'fixture', modelId: 'fixture', family: 'fixture' };
  const initial = plans.createPlan({ title: 'Review fixed scenarios', goal: 'Compare the fixed scenarios', conversationId: child.id, status: 'executing',
    tasks: [{ taskId: 'result', title: 'Publish fixed result', status: 'pending' }], successCriteria: [{ id: 'semantics', kind: 'model_review', description: 'The program computes the declared scenarios.' }],
    delegationOrigin: { workspaceId: 'bot', parentConversationId: parent.id, sessionId: 'session', anchorMessageId: 'anchor', inputId: 'input', phase: 'running', executionGeneration: 'generation',
      modelSelection: { worker: model, explorer: model, verifier: model, resolvedAt: new Date().toISOString() },
      capabilityAdmission: { required: [PUBLISH] } } });
  let enabled = true, leased = true, parentId = parent.id, count = 0, contextLevel = 'D3_private';
  const runtime = createInteractiveRuntime({ rootDir: path.join(root, 'runtime'), goalPlanStore: plans, conversationStore: conversations,
    getBotConversationId: () => parentId, holdsLease: () => leased, enabled: () => enabled, classifyContext: () => contextLevel });
  t.after(() => { runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const current = () => plans.getPlan(initial.planId);
  const profile = kind => normalizeTurnProfile(resolveWorkSessionProfile({ plan: current(), kind }));
  const draft = { publication: { kind: 'create' }, title: 'Fixed trial', textFallback: 'Unverified generated trial.',
    program: program ?? '$x=2\nroot=Col([NumberInput("x","Divisor",$x,1,10,1),Metric("Ratio",@Total(@Data("facts"),"cost")/$x)])',
    inputs: [{ bindingId: 'facts', source: { kind: 'model-data', value: facts ?? [{ cost: 8 }, { cost: 12 }] } }] };
  const publish = (candidate = draft, id = `publish-${++count}`) => runtime.provider.executeCapability({ call: { toolCallId: id, capabilityId: PUBLISH, arguments: candidate } }, {
    toolContext: { workspaceId: 'bot', conversationId: child.id, turnProfile: profile('worker') }, requestPermission: async () => ({ granted: true }) });
  const published = await publish(); assert.equal(published.result.status, 'success', JSON.stringify(published.result.outputPreview));
  const reference = published.result.outputPreview.reference, publicationRef = published.result.evidence.artifactRefs[0];
  plans.recordTaskEvidence(initial.planId, 'result', { status: 'completed', result: 'Published fixed trial', evidenceRefs: [publicationRef] });
  function prepare() { return runtime.verification.prepare({ plan: current(), verifierRunId: 'review', readSourceRevision: p => verificationContentHash(p, 'fixed worker report') }); }
  const inspect = (review, view, extra = {}, ref = reference) => runtime.provider.executeCapability({ call: { toolCallId: `inspect-${++count}`, capabilityId: INSPECT,
    arguments: { target: { kind: 'result', reference: ref }, view, ...extra } } }, { toolContext: { workspaceId: 'bot', conversationId: null,
      turnProfile: normalizeTurnProfile({ ...profile('verifier'), ...(review ? { interactiveReview: review.binding } : {}) }) } });
  async function read(review, view, extra = {}) {
    const execution = await inspect(review, view, extra); assert.equal(execution.result.status, 'success', JSON.stringify(execution.result.outputPreview));
    const refs = execution.result.evidence.refs; assert.equal(refs.length, 1);
    const record = plans.findEvidenceIndexRecords(refs)[0]; assert.ok(record.interactiveInspection);
    assert.equal(record.interactiveInspection.outputDigest.startsWith('sha256:'), true);
    assert.ok(collectToolEvidenceRefs({ toolCallId: execution.call.toolCallId, execution }).includes(refs[0]));
    return { execution, refs, record };
  }
  async function freeze({ fields = ['$x'], requestId = 'selected', value = 4, submit = true } = {}) {
    const identity = { viewId: 'human-view', windowId: 'human-window', generation: 'human-generation' };
    const before = runtime.stateStore.read(reference, () => true), writer = runtime.stateStore.acquire({ reference, identity, expectedRevision: before.stateRevision }, () => true);
    const saved = runtime.stateStore.save({ reference, identity, writer, expectedRevision: before.stateRevision, requestId: `save-${requestId}`, values: { $x: value }, inputDrafts: {} }, () => true);
    const frozen = await runtime.stateStore.prepareFollowup({ reference, identity, writer, stateRevision: saved.stateRevision, stateDigest: saved.stateDigest, fields, requestId }, () => true);
    if (submit) conversations.appendMessage(child.id, { id: `input-${requestId}`, role: 'user', content: 'Use these selected conditions', ...encodeResourceFeedbackTransport([interactiveFeedbackFromFollowup(frozen)]) });
    return frozen;
  }
  return { root, plans, conversations, current, profile, runtime, owner, child, draft, published, reference, publicationRef, publish, prepare, inspect, read, freeze,
    setEnabled: v => { enabled = v; }, setLeased: v => { leased = v; }, setOwner: v => { parentId = v; }, setContextLevel: v => { contextLevel = v; } };
}

test('durable delegated plans pin fixed and inspection evidence after reopen, even without an index entry', async t => {
  const f = await fixture(t), frozen = await f.freeze(), review = f.prepare();
  const { refs } = await f.read(review, 'evaluate', { followupId: frozen.followupId });
  review.close();
  const plan = f.current();
  f.plans.setRunnerState(plan.planId, { verificationContinuation: { schemaVersion: 1, planId: plan.planId,
    continuationId: 'continuation', sourceRevision: review.sourceRevision, modelKey: 'fixture', phase: 'ready',
    deadlineAt: new Date().toISOString(), modelRequests: 1, toolCalls: 1, formatAttempt: 0, evidenceRefs: refs } });
  rmSync(path.join(f.root, 'plans', 'index.jsonl'));
  const plans = createGoalPlanStore({ storeDir: path.join(f.root, 'plans') });
  const conversations = createConversationStore({ storeDir: path.join(f.root, 'conversations') });
  const runtime = createInteractiveRuntime({ rootDir: path.join(f.root, 'runtime'), goalPlanStore: plans, conversationStore: conversations,
    getBotConversationId: () => f.owner.conversationId, holdsLease: () => true, enabled: () => true });
  t.after(() => runtime.close());
  const messages = runtime.feedback.acquireMessageRoots(f.owner);
  try {
    const snapshot = runtime.acquireDelegationRoots(f.owner, messages);
    assert.deepEqual(snapshot.references, [f.reference]);
    assert.deepEqual(snapshot.followupIds, [frozen.followupId]);
    assert.equal(snapshot.assertCurrent(), true);
    plans.setRunnerState(plan.planId, { verificationContinuation: { ...plans.getPlan(plan.planId).runner.verificationContinuation,
      evidenceRefs: ['interactive-inspection://missing'] } });
    assert.equal(snapshot.assertCurrent(), false);
    assert.throws(() => runtime.acquireDelegationRoots(f.owner, messages), { code: 'interactive_delegation_corrupt' });
    const file = path.join(f.root, 'plans', plan.planId + '.json');
    const historical = JSON.parse(readFileSync(file, 'utf8'));
    historical.status = 'completed';
    historical.runner = { status: 'idle' };
    historical.resultAcceptance = { acceptedAt: new Date().toISOString(), acceptedBy: 'user' };
    writeFileSync(file, JSON.stringify(historical));
    assert.deepEqual(runtime.acquireDelegationRoots(f.owner, messages).references, [], 'settled plan evidence is historical');
  } finally { messages.release(); }
});

test('the leased verifier guard pins real review targets and invalidates a cleanup preview when the review ends', async t => {
  const f = await fixture(t), frozen = await f.freeze(), review = f.prepare(), verification = f.runtime.verification;
  const guard = verification.acquireRetentionVerification(f.owner);
  try {
    assert.deepEqual(guard.references, [f.reference]);
    assert.deepEqual(guard.followupIds, [frozen.followupId]);
    assert.equal(guard.assertCurrent(), true);
    assert.throws(f.prepare, { code: 'interactive_retention_busy' });
    assert.throws(() => verification.acquireRetentionVerification(f.owner), { code: 'interactive_retention_busy' });
    f.setLeased(false);
    assert.equal(guard.assertCurrent(), false);
    assert.throws(() => verification.acquireRetentionVerification(f.owner), { code: 'interactive_retention_unavailable' });
    f.setLeased(true);
  } finally { guard.release(); }
  assert.equal(guard.assertCurrent(), false);
  const retention = createInteractiveRetention({ resultStore: f.runtime.resultStore, stateStore: f.runtime.stateStore,
    assertOwner: () => true,
    acquireRoots(owner) {
      const reviewRoots = verification.acquireRetentionVerification(owner);
      return { sources: Object.fromEntries(INTERACTIVE_RETENTION_SOURCES.map(source =>
        [source, source === 'verification' ? reviewRoots.revision : jsonDigest(source)])),
      pins: reviewRoots.references.map(reference => ({ source: 'verification', reference })),
      followupIds: reviewRoots.followupIds, assertCurrent: reviewRoots.assertCurrent, release: reviewRoots.release };
    },
  });
  const preview = retention.preview(f.reference);
  assert.ok(preview.blockers.some(row => row.source === 'verification'));
  assert.ok(preview.blockers.some(row => row.source === 'followup'));
  const closing = verification.acquireRetentionVerification(f.owner);
  try {
    review.close();
    assert.equal(closing.assertCurrent(), false);
  } finally { closing.release(); }
  assert.throws(() => retention.cleanup({ reference: f.reference, requestId: 'cleanup-after-review', expectedDigest: preview.cleanupDigest }),
    { code: 'interactive_retention_stale' });
  assert.equal(retention.preview(f.reference).blockers.some(row => row.source === 'verification'), false);
  assert.ok(f.prepare(), 'the next review can start after guard release');
});

test('actual normalized ephemeral Verifier reads only its fixed targets; complete real inspection coverage is required for a pass', async t => {
  const f = await fixture(t), frozen = await f.freeze(), review = f.prepare(); t.after(() => review.close());
  assert.equal((await f.inspect(null, 'program')).result.status, 'failed', 'role/plan alone cannot open result storage');
  const other = await f.publish({ ...f.draft, title: 'Unreferenced other result' }); assert.equal(other.result.status, 'success');
  assert.notEqual((await f.inspect(review, 'program', {}, other.result.outputPreview.reference)).result.status, 'success');
  const unsubmitted = await f.freeze({ requestId: 'not-submitted', value: 7, submit: false });
  assert.notEqual((await f.inspect(review, 'evaluate', { followupId: unsubmitted.followupId })).result.status, 'success');
  assert.equal(review.validateReport(success([f.publicationRef]), new Set([f.publicationRef])).passed, false);
  const metadata = await f.read(review, 'metadata'), text = await f.read(review, 'text');
  assert.equal(review.validateReport(success([...metadata.refs, ...text.refs]), new Set([...metadata.refs, ...text.refs])).passed, false);
  const rows = [await f.read(review, 'program'), await f.read(review, 'data', { bindingId: 'facts' }),
    await f.read(review, 'evaluate'), await f.read(review, 'evaluate', { followupId: frozen.followupId })];
  const refs = rows.flatMap(row => row.refs), allowed = new Set(refs);
  assert.equal(review.validateReport(success(refs), allowed).passed, true);
  assert.equal(review.validateReport(success(refs.slice(0, -1)), allowed).passed, false, 'initial computation cannot substitute for the frozen state');
  assert.equal(rows.at(-1).execution.result.outputPreview.stateSource.values.$x, 4, 'later mutable state 7 is not admitted');
  assert.deepEqual(rows.at(-1).record.interactiveInspection.stateSource, review.facts.targets.find(row => row.state.kind === 'frozen-followup').state);
  assert.equal(JSON.stringify(rows.at(-1).record).includes('"values"'), false, 'canonical read receipts do not copy private values or program text');
  review.close(); assert.notEqual((await f.inspect(review, 'program')).result.status, 'success');
});

test('canonical inspection receipts survive a real old lossy append descriptor, reopen and a newly issued review token', async t => {
  const f = await fixture(t), review = f.prepare();
  const file = path.join(f.root, 'plans/evidence-index.jsonl');
  const fd = openSync(file, 'a');
  const rows = [await f.read(review, 'program'), await f.read(review, 'data', { bindingId: 'facts' }), await f.read(review, 'evaluate')];
  const refs = rows.flatMap(row => row.refs), original = readFileSync(file, 'utf8');
  try { for (const row of rows) {
    const lossy = legacyNormalize({ ...row.record, planId: 'foreign-plan', conversationId: 'foreign-conversation', toolName: 'goal_update_task' });
    assert.equal(lossy.interactiveInspection, undefined); writeSync(fd, `${JSON.stringify(lossy)}\n`);
  } fsyncSync(fd); } finally { closeSync(fd); }
  assert.ok(readFileSync(file, 'utf8').startsWith(original));
  const reopened = createGoalPlanStore({ storeDir: path.join(f.root, 'plans') });
  for (const row of rows) assert.deepEqual(reopened.findEvidenceIndexRecords(row.refs)[0], row.record);
  review.close(); const resumed = f.prepare(); t.after(() => resumed.close());
  assert.notEqual(resumed.binding.token, review.binding.token); assert.equal(resumed.sourceRevision, review.sourceRevision);
  assert.equal(resumed.validateReport(success(refs), new Set(refs)).passed, true);
  assert.equal(resumed.validateReport(success(refs), new Set()).passed, false, 'persistent facts cannot bypass the original allowed set');
});

test('large fixed bindings remain completely pageable beyond 64 KiB; duplicate pages, gaps and selectors cannot qualify', async t => {
  const f = await fixture(t, { facts: Array.from({ length: 400 }, (_, i) => ({ cost: i, detail: 'x'.repeat(220) })) });
  const review = f.prepare(); t.after(() => review.close());
  const fixed = [await f.read(review, 'program'), await f.read(review, 'evaluate')], pages = [];
  for (let offset = 0;;) {
    const row = await f.read(review, 'data', { bindingId: 'facts', offset }); pages.push(row);
    const output = row.execution.result.outputPreview;
    if (!output.truncated) break;
    assert.ok(output.nextOffset > offset); offset = output.nextOffset;
  }
  assert.ok(pages.some(row => row.record.interactiveInspection.range.offset > 65536));
  const refs = [...fixed, ...pages].flatMap(row => row.refs), allowed = new Set(refs);
  assert.equal(review.validateReport(success(refs), allowed).passed, true);
  const gap = [...fixed, ...pages.filter((_, i) => i !== 4)].flatMap(row => row.refs);
  assert.equal(review.validateReport(success(gap), allowed).passed, false);
  const duplicate = [...fixed, ...Array(30).fill(pages[0])].flatMap(row => row.refs);
  assert.equal(review.validateReport(success(duplicate), allowed).passed, false);
  const subset = await f.read(review, 'data', { bindingId: 'facts', selector: { start: 0, limit: 1 } });
  const subsetRefs = [...fixed, subset].flatMap(row => row.refs);
  assert.equal(review.validateReport(success(subsetRefs), new Set(subsetRefs)).passed, false);
});

test('task aliases resolve the actual same-plan publication even when the global tool alias is overwritten', async t => {
  const f = await fixture(t), alias = `tool-result://${f.published.call.toolCallId}`;
  f.plans.recordEvidenceRefs({ evidenceRef: alias, planId: 'foreign-plan', conversationId: 'foreign-conversation', toolCallId: f.published.call.toolCallId, toolName: 'goal_update_task' });
  f.plans.revisePlan(f.current().planId, { tasks: f.current().tasks.map(row => ({ ...row, evidenceRefs: [alias] })) });
  const review = f.prepare(); t.after(() => review.close());
  assert.deepEqual(review.facts.targets.map(row => row.reference), [f.reference]);
  assert.equal((await f.inspect(review, 'program')).result.status, 'success');
});

test('inspection index failure never returns a qualified inspection reference or a passing report', async t => {
  const f = await fixture(t), review = f.prepare(); t.after(() => review.close());
  const original = f.plans.recordEvidenceRefs;
  f.plans.recordEvidenceRefs = () => { throw Object.assign(Error('disk failure'), { code: 'inspection_disk_failure' }); };
  const failed = await f.inspect(review, 'program');
  assert.equal(failed.result.status, 'failed');
  assert.equal(collectToolEvidenceRefs({ toolCallId: failed.call.toolCallId, execution: failed }).some(ref => ref.startsWith('interactive-inspection://')), false);
  assert.equal(review.validateReport(success([f.publicationRef]), new Set([f.publicationRef])).passed, false);
  f.plans.recordEvidenceRefs = original;
  assert.equal((await f.inspect(review, 'program')).result.status, 'success');
});

test('actual ephemeral inspection observations retain privacy without admitting bodies or restoring an expired review', async t => {
  const f = await fixture(t), review = f.prepare();
  f.setContextLevel('D4_regulated');
  const execution = await f.inspect(review, 'program'); assert.equal(execution.result.evidence.dataLevel, 'D4_regulated');
  review.close(); f.setContextLevel('D3_private');
  const context = { workspaceId: f.owner.workspaceId, conversationId: null, turnProfile: { ...f.profile('verifier'), interactiveReview: review.binding } };
  const captured = f.runtime.captureExecution(execution, context);
  assert.equal(captured.interactiveMaterial, undefined);
  assert.equal(f.runtime.resultStore.ownerDataLevel(f.owner, 'D3_private'), 'D4_regulated');
  assert.notEqual((await f.inspect(review, 'program')).result.status, 'success');
});

for (const complete of [false, true]) test(`actual GoalHost → Desktop Executor → normalized ephemeral Provider enforces factual coverage: ${complete}`, async t => {
  const f = await fixture(t), frozen = await f.freeze(), events = [];
  let calls = 0, issuedProfile;
  const originalFetch = globalThis.fetch, requests = [];
  const uninstall = installDesktopInteractiveRuntime({ runtime: f.runtime, enabled: () => true });
  t.after(() => { globalThis.fetch = originalFetch; uninstall(); });
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init.body); requests.push(request);
    assert.equal(JSON.stringify(request).includes(issuedProfile.interactiveReview.token), false);
    const refs = f.plans.listEvidenceIndex().filter(row => row.interactiveInspection).map(row => row.evidenceRef);
    const frames = requests.length === 1 ? [
      ...[{ view: 'program' }, { view: 'data', bindingId: 'facts' }, { view: 'evaluate' }, { view: 'evaluate', followupId: frozen.followupId }].flatMap((extra, i) => [
        { type: 'response.output_item.added', item: { type: 'function_call', id: `fc-${i}`, call_id: `inspect-${i}`, name: 'inspect_interactive_result' } },
        { type: 'response.function_call_arguments.done', item_id: `fc-${i}`, arguments: JSON.stringify({ target: { kind: 'result', reference: f.reference }, ...extra }) },
      ]), { type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 20 } } },
    ] : [
      { type: 'response.output_text.delta', delta: JSON.stringify(success(refs)) },
      { type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 20 } } },
    ];
    assert.ok(requests.length <= 2, 'no extra request or format repair');
    return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const executor = createAgentTurnExecutor({ llmChatService: { async sendMessage(input) {
    calls++;
    issuedProfile = normalizeTurnProfile(input.turnProfile);
    assert.equal(input.conversationId, null);
    assert.ok(issuedProfile.executionIdentity);
    assert.ok(issuedProfile.interactiveReview?.token);
    assert.equal(JSON.stringify(input.messages).includes(issuedProfile.interactiveReview.token), false);
    assert.match(JSON.stringify(input.messages), /targetsDigest/);
    assert.match(JSON.stringify(input.runtimeReminders), /interactive/i);
    if (complete) {
      const { registry, projection, modelProjection } = createRuntimeToolProjection({ projectionOptions: {
        mode: 'explorer', turnProfile: issuedProfile, readOnlyWorkSession: true } });
      const tools = buildOpenAIToolsFromModelProjection(modelProjection);
      assert.equal(tools.some(tool => tool.function?.name === 'inspect_interactive_result'), true);
      await agentLoopOpenAI({ baseUrl: 'https://fixture.invalid', apiKey: 'controlled-transport', authMethod: 'oauth_chatgpt', providerId: 'fixture', model: 'fixture',
        systemPrompt: 'Readonly verifier.', messages: input.messages, tools, streamId: input.streamId, signal: input.signal,
        executionBudget: input.executionBudget, workspacePath: f.root, conversationId: null, runtimeMode: 'explorer', registry,
        runtimeProjection: projection, goalPlanStore: f.plans, toolContext: { mode: 'explorer', turnRole: 'work_session', agentKind: 'verifier',
          planId: f.current().planId, workspaceId: 'bot', conversationId: null, turnProfile: issuedProfile, readFiles: new Map(), turnToolCalls: [], turnId: input.streamId },
        permissionGate: { createFilePermissionRequester: () => async () => ({ granted: true }),
          createLocalCapabilityPermissionRequester: () => async () => ({ granted: true }), createShellApprovalDecider: () => async () => ({ granted: true }) },
        webContents: input.webContents });
      return { terminalStatus: 'done' };
    }
    input.webContents.send('chat:stream:delta', { content: JSON.stringify(success([f.publicationRef])) });
    return { terminalStatus: 'done' };
  } } });
  const host = createProjectGoalRunnerHost({ agentTurnExecutor: executor, goalPlanStore: f.plans, conversationStore: f.conversations,
    llmChatService: {}, broadcast: (channel, payload) => events.push({ channel, payload }), hostLeases: { holds: () => true }, workspaceRoot: f.root,
    resolveConversationModelProviderId: () => 'fixture', getInteractiveVerification: () => f.runtime.verification });
  let verdict;
  const verification = createSessionVerification({ goalPlanStore: f.plans, verifySession: async plan => {
    verdict = await host.verifierRunner.runVerifier({ plan, verifierRunId: 'actual-host-review', stage: 'delegated' });
    return verdict;
  } });
  await verification.markVerifying('session');
  let accepted;
  try { accepted = await verification.run({ sessionId: 'session' }); }
  finally { await verification.finish('session'); }
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(accepted.facts.independentVerifier, complete ? 'passed' : 'failed');
  assert.equal(verification.facts('session').independentVerifier, complete ? 'passed' : 'missing');
  assert.equal(verdict.passed, complete, JSON.stringify(verdict));
  assert.equal(calls, 1, 'semantic missing coverage is not a report-format retry');
  assert.equal(requests.length, complete ? 2 : 0);
  if (!complete) assert.match(JSON.stringify(verdict.missingEvidence), /interactive_verification_evidence_missing/);
  assert.notEqual((await f.inspect({ binding: issuedProfile.interactiveReview }, 'program')).result.status, 'success', 'finished host review closes the private lifetime token');
});

test('owner, feature withdrawal, execution generation and new admitted conditions invalidate the original review', async t => {
  const f = await fixture(t);
  for (const mutate of [() => f.setOwner('different-parent'), () => f.setLeased(false), () => f.setEnabled(false),
    () => f.plans.revisePlan(f.current().planId, { delegationOrigin: { ...f.current().delegationOrigin, executionGeneration: 'different' } }),
    () => f.freeze()]) {
    f.setOwner(f.owner.conversationId); f.setLeased(true); f.setEnabled(true);
    f.plans.revisePlan(f.current().planId, { delegationOrigin: { ...f.current().delegationOrigin, executionGeneration: 'generation' } });
    const review = f.prepare(); await mutate();
    assert.throws(() => review.validateReport(success([f.publicationRef]), new Set([f.publicationRef])));
    assert.notEqual((await f.inspect(review, 'program')).result.status, 'success'); review.close();
  }
});

test('the inspection receipt protocol rejects wrong owner, arbitrary authority fields, future schema and invalid ranges', async t => {
  const f = await fixture(t), review = f.prepare(); t.after(() => review.close());
  const { record } = await f.read(review, 'program'), receipt = record.interactiveInspection;
  assert.deepEqual(normalizeInteractiveInspectionReceipt(receipt), receipt);
  assert.equal(interactiveInspectionEvidenceRef(receipt.evidenceId), record.evidenceRef);
  for (const patch of [{ schemaVersion: 2 }, { grant: true }, { owner: { ...f.owner, workspaceId: 'foreign' } },
    { range: { ...receipt.range, offset: 1 } }, { range: { ...receipt.range, returned: 4001 } },
    { request: { ...receipt.request, limit: 1 } },
    { stateSource: { kind: 'initial', stateDigest: receipt.outputDigest } }, { review: { ...receipt.review, token: review.binding.token } }]) {
    assert.equal(normalizeInteractiveInspectionReceipt({ ...receipt, ...patch }), undefined);
  }
  const evaluation = (await f.read(review, 'evaluate')).record.interactiveInspection;
  assert.equal(normalizeInteractiveInspectionReceipt({ ...evaluation, computationTruncated: undefined }), undefined);
});
