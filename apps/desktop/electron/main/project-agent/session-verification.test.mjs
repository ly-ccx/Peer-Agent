import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createGoalPlanStore } from '../../../../../packages/runtime-node/src/goal-plan-store.mjs';
import { createSessionSupervisor } from '../../../../../packages/runtime-node/src/project-agent/session-supervisor.mjs';
import { createDelegationProvider } from '../../../../../packages/runtime-node/src/project-agent/delegation-provider.mjs';
import { createLocalToolHost } from '../runtime-gateway/local-tool-host.mjs';
import { runVerifierWithReport } from '../../../../../packages/runtime-node/src/project-agent/verifier-report.mjs';
import {
  createSessionVerification,
  installSessionVerification,
} from './session-verification.mjs';

const selection = {
  providerId: 'local',
  modelId: 'worker-1',
  modelProviderId: 'worker-1',
  family: 'alpha',
};

test('unavailable, invalid and throwing verifiers leave no permanent verifying flag or invented verdict', async () => {
  for (const verifySession of [undefined, async () => { throw Error('offline'); }, async () => ({ ok: false }), async () => null]) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'verify-failed-'));
    const store = createGoalPlanStore({ storeDir: path.join(root, 'goal-plans') });
    try {
      const plan = store.createPlan({ conversationId: 'child-1', title: 'Read', goal: 'Read', successCriteria: ['Read'],
        tasks: [], delegationOrigin: origin(), hostVerification: { independentVerifier: 'missing' } });
      const verification = createSessionVerification({ goalPlanStore: store, verifySession });
      const provider = createDelegationProvider({ verification });
      const executed = await provider.executeCapability({ call: { toolCallId: 'fail', capabilityId: 'local.delegation.verify_session',
        arguments: { sessionId: 'session-1' } } }, { mode: 'project_agent', role: 'project_agent', messages: [{ id: 'u1', role: 'user', kind: 'user_input' }] });
      const result = JSON.parse(executed.result.outputPreview.legacyResult.output);
      assert.equal(result.ok, false);
      assert.notEqual(store.getPlan(plan.planId).delegationOrigin.verifying, true, JSON.stringify(result));
      assert.notEqual(store.getPlan(plan.planId).hostVerification?.independentVerifier, 'passed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('failed verdict persistence still finishes the transient verification state', async () => {
  let active = false, finishes = 0;
  const provider = createDelegationProvider({ verification: {
    markVerifying: () => { active = true; },
    run: async () => ({ ok: true, facts: { plan: { tasks: [] }, evidenceIndex: [], independentVerifier: 'failed' } }),
    record: () => { throw Error('disk error'); },
    finish: () => { active = false; finishes++; },
  } });
  await provider.executeCapability({ call: { toolCallId: 'fail', capabilityId: 'local.delegation.verify_session', arguments: { sessionId: 'session-1' } } },
    { mode: 'project_agent', role: 'project_agent', messages: [] }).catch(() => {});
  assert.equal(active, false); assert.equal(finishes, 1);
});

function origin(extra = {}) {
  return {
    anchorMessageId: 'anchor-1',
    inputId: 'input-1',
    surface: 'desktop',
    workspaceId: 'ws-1',
    sessionId: 'session-1',
    parentConversationId: 'parent-1',
    readOnly: true,
    phase: 'running',
    depth: 1,
    modelSelection: {
      worker: selection,
      explorer: selection,
      verifier: { ...selection, modelId: 'verifier-1', modelProviderId: 'verifier-1', family: 'beta', sameFamilyAsWorker: false },
      source: { worker: 'global', verifier: 'global' },
      resolvedAt: '2026-09-27T00:00:00.000Z',
    },
    ...extra,
  };
}

test('a timed out verify_session clears verifying and never persists its late successful report', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'verify-timeout-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createGoalPlanStore({ storeDir: path.join(root, 'goal-plans') });
  const plan = store.createPlan({ conversationId: 'child-1', title: 'Review', goal: 'Review', tasks: [],
    successCriteria: [{ id: 'review', kind: 'model_review', description: 'Review real evidence' }], delegationOrigin: origin() });
  let finish;
  const verification = createSessionVerification({ goalPlanStore: store,
    verifySession: () => {
      assert.equal(store.getPlan(plan.planId).delegationOrigin.verifying, true);
      return runVerifierWithReport({ timeoutMs: 20, run: () => new Promise(resolve => { finish = resolve; }) });
    } });
  const provider = createDelegationProvider({ verification });
  const executed = await provider.executeCapability({ call: { toolCallId: 'timeout', capabilityId: 'local.delegation.verify_session',
    arguments: { sessionId: 'session-1' } } }, { mode: 'project_agent', role: 'project_agent', messages: [] });
  const result = JSON.parse(executed.result.outputPreview.legacyResult.output);
  assert.equal(result.error, 'verifier_timeout');
  assert.notEqual(store.getPlan(plan.planId).delegationOrigin.verifying, true);
  finish({ events: [{ channel: 'chat:stream:delta', payload: { content: JSON.stringify({ passed: true, evidenceRefs: ['forged'] }) } },
    { channel: 'chat:stream:done', payload: {} }] });
  await new Promise(resolve => setImmediate(resolve));
  const after = store.getPlan(plan.planId);
  assert.notEqual(after.hostVerification?.independentVerifier, 'passed');
  assert.equal(after.runner.verifierRuns.length, 1, 'the failed attempt keeps its timeout diagnosis');
  assert.equal(after.runner.verifierRuns[0].status, 'failed');
});

test('verification failures retain cancellation and permission classifications', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'verify-classification-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createGoalPlanStore({ storeDir: path.join(root, 'goal-plans') });
  store.createPlan({ conversationId: 'child-1', title: 'Review', goal: 'Review', tasks: [], delegationOrigin: origin() });
  for (const code of ['verifier_cancelled', 'verifier_permission_denied']) {
    const verification = createSessionVerification({ goalPlanStore: store,
      verifySession: () => { throw Object.assign(new Error('failed'), { code }); } });
    assert.equal((await verification.run({ sessionId: 'session-1' })).error, code);
  }
});

test('a concurrent review reports waiting without recording a failed verdict for the active review', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'verify-busy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createGoalPlanStore({ storeDir: path.join(root, 'goal-plans') });
  const plan = store.createPlan({ conversationId: 'child-1', title: 'Review', goal: 'Review',
    tasks: [], delegationOrigin: origin() });
  const verification = createSessionVerification({ goalPlanStore: store,
    verifySession: () => { throw Object.assign(new Error('verifier_in_progress'), { code: 'verifier_in_progress' }); } });
  const result = await verification.run({ sessionId: 'session-1' });
  assert.equal(result.error, 'verifier_in_progress');
  assert.equal(result.nextAction, 'wait_for_verification');
  assert.equal(store.getPlan(plan.planId).runner?.verifierRuns?.length || 0, 0);
});

test('verify_session preserves the concrete failure and next action through the Provider and persisted history', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'verify-diagnostic-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createGoalPlanStore({ storeDir: path.join(root, 'goal-plans') });
  const plan = store.createPlan({ conversationId: 'child-1', title: 'Review', goal: 'Review', tasks: [], delegationOrigin: origin() });
  const verification = createSessionVerification({ goalPlanStore: store, verifySession: () => { throw Error('Review adapter disconnected after paired file results'); } });
  const provider = createDelegationProvider({ verification });
  const executed = await provider.executeCapability({ call: { toolCallId: 'failure', capabilityId: 'local.delegation.verify_session', arguments: { sessionId: 'session-1' } } },
    { mode: 'project_agent', role: 'project_agent', messages: [] });
  const result = JSON.parse(executed.result.outputPreview.legacyResult.output);
  assert.equal(result.error, 'verifier_failed');
  assert.match(result.message, /disconnected after paired file results/);
  assert.equal(result.nextAction, 'inspect_and_repair');
  assert.match(store.getPlan(plan.planId).runner.verifierRuns.at(-1).failureReason, /disconnected after paired file results/);
  assert.notEqual(store.getPlan(plan.planId).hostVerification?.independentVerifier, 'passed');
});

test('get_verification_detail exposes persisted actual failures for a same-model review after restart', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'verify-model-diagnostic-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const storeDir = path.join(root, 'goal-plans');
  const store = createGoalPlanStore({ storeDir });
  const same = { ...selection, reasoningEffort: 'max' };
  const plan = store.createPlan({ conversationId: 'child-1', title: 'Review', goal: 'Review',
    successCriteria: [{ id: 'c', kind: 'model_review', description: 'Review the packet' }],
    tasks: [{ taskId: 't', title: 'Read', status: 'completed', evidenceRefs: ['ev-read'] }],
    delegationOrigin: origin({ modelSelection: { worker: same, explorer: same,
      verifier: { ...same, sameFamilyAsWorker: true }, source: { worker: 'project', verifier: 'project' },
      resolvedAt: '2026-10-20T00:00:00Z' } }) });
  store.recordEvidenceRefs({ planId: plan.planId, conversationId: 'child-1', evidenceRef: 'ev-read', toolName: 'read_file' });
  const verification = createSessionVerification({ goalPlanStore: store, verifySession: async () => ({ passed: false,
    failedCriteria: [{ criterionId: 'c', reason: 'Missing review.json and product verify evidence', evidenceRefs: ['ev-read'] }],
    missingEvidence: [{ taskId: 't', reason: 'Review screenshots before acceptance' }], evidenceRefs: ['ev-read'] }) });
  await verification.run({ sessionId: 'session-1' });
  store.recordVerifierRun(plan.planId, { verifierRunId: 'timeout', target: { kind: 'plan' }, status: 'failed',
    failureReason: 'agent_loop_exhausted: configured turn budget (12)', report: { passed: false, risks: ['Review did not finish'] } });
  const reopened = createGoalPlanStore({ storeDir });
  const provider = createDelegationProvider({ verification: createSessionVerification({ goalPlanStore: reopened }) });
  const result = await provider.executeCapability({ call: { toolCallId: 'detail', capabilityId: 'local.delegation.get_verification_detail',
    arguments: { sessionId: 'session-1' } } }, { mode: 'project_agent', role: 'project_agent', messages: [] });
  const detail = JSON.parse(result.result.outputPreview.legacyResult.output);
  assert.equal(detail.sameSource, true);
  assert.equal(detail.workerModel, detail.verifierModel);
  assert.notEqual(detail.outcome, 'passed');
  assert.equal(detail.reviewAttempts[0].failedCriteria[0].reason, 'Missing review.json and product verify evidence');
  assert.equal(detail.reviewAttempts[0].matchesCurrentSource, true);
  assert.match(detail.reviewAttempts[1].failureReason, /agent_loop_exhausted/);
  assert.equal(detail.reviewAttempts[1].matchesCurrentSource, null);
  assert.ok(detail.reviewAttempts.every(row => row.diagnosticOnly === true));
  assert.deepEqual(reopened.getPlan(plan.planId).delegationOrigin.modelSelection, store.getPlan(plan.planId).delegationOrigin.modelSelection);
});

test('桌面复核端口从宿主计划和证据索引取事实，复核完成后退出 verifying', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'b3-04-verify-'));
  const store = createGoalPlanStore({ storeDir: path.join(root, 'goal-plans') });
  const appended = [];
  try {
    const created = store.createPlan({
      conversationId: 'child-1',
      title: '登录',
      goal: '登录',
      successCriteria: ['能登录'],
      tasks: [{ taskId: 'leaf', status: 'completed', evidenceRefs: ['tool-result://host-verifier'] }],
      delegationOrigin: origin(),
    });
    store.registerEvidenceRefs?.(created.planId, ['tool-result://host-verifier']);
    const verification = createSessionVerification({
      goalPlanStore: store,
      verifySession: async (plan, focus) => {
        assert.equal(plan.planId, created.planId);
        assert.equal(focus, '登录');
        return { passed: true, verifierModel: 'verifier-1', sameFamilyAsWorker: false };
      },
      appendMessage: (conversationId, message) => appended.push({ conversationId, message }),
    });
    installSessionVerification(verification);
    const supervisor = createSessionSupervisor({
      conversationStore: {
        getConversation() { return null; },
        getPersistedConversationHistory() { return { messages: [] }; },
      },
      goalPlanStore: store,
      goalRunner: { async start() {} },
    });
    const provider = createDelegationProvider({ verification });
    const reviewed = JSON.parse((await provider.executeCapability({
      call: {
        toolCallId: 'verify-1',
        capabilityId: 'local.delegation.verify_session',
        arguments: { sessionId: 'session-1', focus: '登录' },
      },
    }, {
      mode: 'project_agent',
      role: 'project_agent',
      messages: [{ id: 'u1', role: 'user', kind: 'user_input' }],
    })).result.outputPreview.legacyResult.output);
    assert.equal(reviewed.ok, true);
    assert.equal(reviewed.status, reviewed.event.outcome);
    assert.notEqual(store.getPlan(created.planId).delegationOrigin.verifying, true);
    assert.equal(supervisor.get({ sessionId: 'session-1' }).status, 'running');
    assert.equal(appended[0].conversationId, 'parent-1');
    assert.equal(appended[0].message.kind, 'system_card');
    assert.equal(appended[0].message.cards[0].content, reviewed.event.outcome);

    const host = createLocalToolHost({
      workspaceRoot: root,
      userDataPath: root,
      sessionStore: { getSession: () => ({ locale: 'zh-CN' }) },
    });
    const executed = await host.execute({
      sessionId: 'session-1',
      projectionId: 'projection-1',
      conversationId: 'parent-1',
      call: {
        toolCallId: 'detail-1',
        capabilityId: 'local.delegation.get_verification_detail',
        arguments: { sessionId: 'session-1' },
      },
    }, {
      mode: 'project_agent',
      role: 'project_agent',
      toolContext: { mode: 'project_agent', turnRole: 'project_agent', messages: [] },
    });
    const detail = JSON.parse(executed.result.outputPreview.legacyResult.output);
    assert.equal(detail.ok, true);
    assert.equal(detail.sessionId, 'session-1');
    assert.equal(detail.workerModel, 'worker-1');
    assert.equal(detail.sameSource, false);
  } finally {
    installSessionVerification(null);
    rmSync(root, { recursive: true, force: true });
  }
});


test('semantic review is bound to indexed evidence and the current report, overriding a stale missing verdict', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'r88-semantic-verification-'));
  const store = createGoalPlanStore({ storeDir: path.join(root, 'goal-plans') });
  try {
    const plan = store.createPlan({ conversationId: 'child-1', title: 'Read', goal: 'Read',
      successCriteria: [{ id: 'c1', kind: 'model_review', description: 'Explain project' }],
      tasks: [{ taskId: 'read', status: 'completed', result: 'Actual findings', evidenceRefs: ['ev-read'] }],
      delegationOrigin: origin(), hostVerification: { independentVerifier: 'missing' } });
    store.recordEvidenceRefs({ planId: plan.planId, evidenceRef: 'ev-read', toolName: 'read_file', capabilityId: 'local.file.read' });
    const firstReview = createSessionVerification({ goalPlanStore: store, verifySession: async () => ({ passed: false, evidenceRefs: ['ev-read'] }) });
    await firstReview.run({ sessionId: 'session-1' });
    const rejectedAttempt = store.getPlan(plan.planId).runner.verifierRuns.at(-1).verifierRunId;
    const verification = createSessionVerification({ goalPlanStore: store, verifySession: async () => ({ passed: true, evidenceRefs: ['ev-read'] }) });
    assert.equal((await verification.run({ sessionId: 'session-1' })).ok, true);
    assert.equal(verification.facts('session-1').independentVerifier, 'passed');
    const attempts = store.getPlan(plan.planId).runner.verifierRuns;
    assert.equal(attempts.find(row => row.verifierRunId === rejectedAttempt).status, 'failed');
    assert.notEqual(attempts.at(-1).verifierRunId, rejectedAttempt);
    store.revisePlan(plan.planId, { tasks: [{ taskId: 'read', status: 'completed', result: 'Changed report', evidenceRefs: ['ev-read'] }] }, { changedBy: 'test', reason: 'source updated' });
    assert.equal(verification.facts('session-1').independentVerifier, 'missing');
    const invalid = createSessionVerification({ goalPlanStore: store, verifySession: async () => ({ passed: true, evidenceRefs: ['invented'] }) });
    assert.equal((await invalid.run({ sessionId: 'session-1' })).facts.independentVerifier, 'failed');
    assert.equal(verification.facts('session-1').independentVerifier, 'missing');
    const changed = createSessionVerification({ goalPlanStore: store, verifySession: async () => {
      store.revisePlan(plan.planId, { goal: 'Different task' }, { changedBy: 'test', reason: 'source updated during verifier' });
      return { passed: true, evidenceRefs: ['ev-read'] };
    } });
    assert.equal((await changed.run({ sessionId: 'session-1' })).error, 'verification_source_changed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the production reconciliation port checks host ownership and liveness without inventing a verdict', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'verify-reconcile-'));
  const store = createGoalPlanStore({ storeDir: path.join(root, 'goal-plans') });
  try {
    const plan = store.createPlan({ conversationId: 'child-1', title: 'Review', goal: 'Review', tasks: [],
      delegationOrigin: origin({ verifying: true }), hostVerification: { independentVerifier: 'missing' } });
    let requests = 0;
    const verification = createSessionVerification({ goalPlanStore: store, verifySession: () => { requests++; } });
    const input = { workspaceId: 'ws-1', parentConversationId: 'parent-1', sessionId: 'session-1' };
    const before = store.getPlan(plan.planId);
    const receipt = verification.reconcileInterrupted(input);
    assert.equal(receipt.status, 'inactive');
    assert.equal(receipt.planId, plan.planId);
    assert.equal(typeof receipt.sourceRevision, 'string');
    assert.deepEqual(store.getPlan(plan.planId), before, 'querying liveness does not mutate plan, quality or acceptance');
    assert.equal(verification.reconcileInterrupted({ ...input, workspaceId: 'other' }).status, 'unavailable');
    assert.equal(verification.reconcileInterrupted({ ...input, parentConversationId: 'other' }).status, 'unavailable');
    await verification.markVerifying('session-1');
    assert.equal(verification.reconcileInterrupted(input).status, 'active');
    await verification.finish('session-1');
    assert.equal(verification.reconcileInterrupted(input).status, 'inactive');
    assert.equal(requests, 0);
    assert.notEqual(store.getPlan(plan.planId).hostVerification?.independentVerifier, 'passed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
