import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createGoalPlanStore } from '../goal-plan-store.mjs';
import { createGoalRunner } from '../goal-runner.mjs';
import { createSessionVerification } from './session-verification.mjs';
import { createDelegationProvider } from './delegation-provider.mjs';
import { createSessionSupervisor } from './session-supervisor.mjs';

function fixture(t, { policy = 'auto', changeDuringReview = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'verify-completion-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createGoalPlanStore({ storeDir: path.join(root, 'plans') });
  const model = { providerId: 'p', modelId: 'm', modelProviderId: 'm', family: 'f' };
  const created = store.createPlan({ conversationId: 'child', title: '只读核对', goal: '核对实际报告', workflowKind: 'goal_self_driven',
    successCriteria: [{ id: 'c', kind: 'file-exists', description: '源文件存在', path: 'README.md' }],
    criterionResults: [{ criterionId: 'c', passed: true, evidenceRef: 'tool-result://read' }],
    tasks: [{ taskId: 't', title: '核对', status: 'completed', result: '已有报告', evidenceRefs: ['tool-result://read'] }],
    delegationOrigin: { sessionId: 's', workspaceId: 'w', parentConversationId: 'parent', anchorMessageId: 'u',
      inputId: 'input', surface: 'desktop', depth: 1, phase: 'running', readOnly: true,
      modelSelection: { worker: model, explorer: model, verifier: model, source: { worker: 'global', verifier: 'global' }, resolvedAt: '2026-10-07T00:00:00Z' } } });
  store.recordEvidenceRefs({ planId: created.planId, conversationId: 'child', evidenceRef: 'tool-result://read', toolName: 'read_file' });
  store.revisePlan(created.planId, { status: 'executing', runner: { enabled: true, status: 'blocked', intent: 'verify', phase: 'repair',
    blockedReason: 'Verifier failed: missing report', blockerAudit: { reason: 'verifier_failed' } } }, { reason: 'old failure' });
  const events = [];
  const runner = createGoalRunner({ goalPlanStore: store, chatRuntime: { runGoalTurn() { throw Error('must not restart worker'); } },
    emitEvent: event => events.push(event), canRunPlan: () => true });
  let report = '实际四项报告', runs = 0;
  const verification = createSessionVerification({ goalPlanStore: store, readReport: () => report,
    completeRecheck: input => runner.completeRecheck(input),
    verifySession: async () => { runs++; if (changeDuringReview) report += ' changed'; return { passed: true }; } });
  const provider = createDelegationProvider({ verification });
  const supervisor = createSessionSupervisor({ goalPlanStore: store, goalRunner: runner, deferRecovery: true,
    resolveAcceptancePolicy: () => policy, readSessionFacts: () => ({ hostAuthority: verification.facts('s') }),
    conversationStore: { getConversation: () => null, getPersistedConversationHistory: () => ({ messages: [
      { id: 'u', role: 'user', kind: 'user_input', content: '只读核对' },
      { id: 'reply', role: 'assistant', kind: 'agent_reply', content: '核对结果已汇报', sources: ['s'] },
    ] }) } });
  const verify = async () => {
    const result = await provider.executeCapability({ call: { toolCallId: `check-${runs}`, capabilityId: 'local.delegation.verify_session',
      arguments: { sessionId: 's' } } }, { mode: 'project_agent', role: 'project_agent', workspaceId: 'w', messages: [] });
    return JSON.parse(result.result.outputPreview.legacyResult.output);
  };
  return { store, runner, supervisor, verify, events, plan: () => store.getPlan(created.planId), runs: () => runs };
}

test('a real recheck resolves the old readonly failure and policy accepts the reported result without a user card', async t => {
  const f = fixture(t);
  assert.equal(f.supervisor.get({ sessionId: 's' }).status, 'waiting_user');
  assert.equal((await f.verify()).status, 'passed');
  assert.equal(f.plan().status, 'completed');
  assert.equal(f.plan().runner.status, 'completed');
  assert.equal(f.plan().runner.blockedReason, undefined);
  assert.equal(f.events.filter(e => e.type === 'goalRunner:completed').length, 1);
  const accepted = await f.supervisor.settle('s');
  assert.equal(accepted.accepted, true);
  assert.equal(f.plan().resultAcceptance.acceptedBy, 'policy');
  assert.equal(f.supervisor.get({ sessionId: 's' }).status, 'accepted');
  await f.verify();
  assert.equal(f.events.filter(e => e.type === 'goalRunner:completed').length, 1);
  assert.equal(f.runs(), 1, 'an idempotent repeat neither restarts the worker nor loops the verifier');
});

test('confirm policy still requires the existing main-conversation host confirmation', async t => {
  const f = fixture(t, { policy: 'confirm' });
  await f.verify();
  assert.equal((await f.supervisor.settle('s')).accepted, false);
  assert.equal(f.supervisor.get({ sessionId: 's' }).status, 'result_ready');
  assert.equal((await f.supervisor.confirmResult('s')).accepted, true);
  assert.equal(f.plan().resultAcceptance.acceptedBy, 'user');
});

test('completed worker facts with a failed attempt are resolved by a fresh host recheck without worker replay', async t => {
  const f = fixture(t), plan = f.plan();
  f.store.revisePlan(plan.planId, { status: 'completed', runner: { ...plan.runner, status: 'failed',
    blockedReason: undefined, blockerAudit: null } }, { reason: 'verifier attempt crashed' });
  f.store.recordVerifierRun(plan.planId, { verifierRunId: 'old-failure', target: { kind: 'plan' },
    status: 'failed', failureReason: 'verifier unavailable', evidenceRefs: [] });
  await f.verify();
  assert.equal(f.plan().runner.status, 'completed');
  assert.equal(f.plan().runner.verifierRuns.find(row => row.verifierRunId === 'old-failure').status, 'failed');
  assert.equal((await f.supervisor.settle('s')).accepted, true);
});

test('a changing report rejects the verdict and cannot clear the old failure', async t => {
  const f = fixture(t, { changeDuringReview: true });
  assert.equal((await f.verify()).error, 'verification_source_changed');
  assert.equal(f.plan().runner.status, 'blocked');
  assert.notEqual(f.plan().hostVerification?.independentVerifier, 'passed');
  assert.notEqual(f.plan().delegationOrigin.verifying, true);
  assert.equal(f.plan().resultAcceptance, undefined);
});

test('existing manual confirmation remains effective after recheck, without asking the user to accept again', async t => {
  const f = fixture(t), plan = f.plan();
  f.store.revisePlan(plan.planId, { successCriteria: [{ id: 'c', kind: 'manual', description: '核对报告内容' }] }, { reason: 'manual criterion' });
  f.store.recordManualConfirmation(plan.planId, { confirmationId: 'review', kind: 'manual_dod', decision: 'approve',
    criterionIds: ['c'], decidedBy: 'local_ui', decidedAt: new Date().toISOString() });
  await f.verify();
  assert.equal(f.plan().runner.status, 'completed');
  assert.equal((await f.supervisor.settle('s')).accepted, true);
  assert.equal(f.plan().manualConfirmations.length, 1);
});

test('a recheck cannot finish a paused, active, writing or unrelated blocked task, nor bypass missing evidence or manual DoD', async t => {
  for (const kind of ['paused', 'active', 'write', 'approval', 'evidence', 'manual']) {
    await t.test(kind, async t => {
      const f = fixture(t), plan = f.plan();
      const patch = kind === 'paused' ? { delegationOrigin: { ...plan.delegationOrigin, phase: 'paused' } }
        : kind === 'write' ? { delegationOrigin: { ...plan.delegationOrigin, readOnly: false } }
        : kind === 'active' ? { runner: { ...plan.runner, status: 'running' } }
        : kind === 'approval' ? { runner: { ...plan.runner, blockedReason: 'manual_dod_confirmation_required', blockerAudit: null } }
        : kind === 'manual' ? { successCriteria: [{ id: 'c', kind: 'manual', description: '必须由用户核对' }], activation: { enabled: true } }
        : { tasks: [{ ...plan.tasks[0], evidenceRefs: ['tool-result://unknown'] }] };
      f.store.revisePlan(plan.planId, patch, { reason: 'pending gate' });
      await f.verify();
      assert.notEqual(f.plan().runner.status, 'completed');
      assert.equal(f.plan().resultAcceptance, undefined);
      assert.equal(f.events.filter(e => e.type === 'goalRunner:completed').length, 0);
    });
  }
});
