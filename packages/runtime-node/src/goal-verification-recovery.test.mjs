import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGoalPlanStore } from './goal-plan-store.mjs';
import { createGoalRunner } from './goal-runner.mjs';

function fixture(t, { mechanical = false, completed = false, delegated = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'goal-verification-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createGoalPlanStore({ storeDir: path.join(root, 'plans') });
  const model = { providerId: 'p', modelId: 'm', modelProviderId: 'p', family: 'openai' };
  const plan = store.createGoalContract({ conversationId: 'worker', goal: 'Inspect project',
    successCriteria: [{ id: 'c1', kind: mechanical ? 'file-exists' : 'model_review',
      description: 'Report supported by project files', ...(mechanical ? { path: 'README.md' } : {}) }],
    ...(delegated ? { delegationOrigin: { sessionId: 's', workspaceId: 'w', phase: 'running', readOnly: true,
      anchorMessageId: 'input', inputId: 'i', parentConversationId: 'parent',
      modelSelection: { worker: model, explorer: model, verifier: model, source: { worker: 'global' }, resolvedAt: '2026-10-28T00:00:00Z' } } } : {}),
    tasks: [{ taskId: 'read', title: 'Read project', status: completed ? 'completed' : 'pending',
      ...(completed ? { result: 'Initial report', evidenceRefs: ['tool-result://read'] } : {}) }] });
  store.recordEvidenceRefs({ planId: plan.planId, conversationId: 'worker', evidenceRefs: ['tool-result://read'] });
  return { store, plan };
}
const fail = { passed: false, evidenceRefs: ['tool-result://read'],
  failedCriteria: [{ criterionId: 'c1', reason: 'Repository identity missing' }], missingEvidence: [] };
const pass = { passed: true, evidenceRefs: ['tool-result://read'], failedCriteria: [], missingEvidence: [] };

for (const delegated of [false, true]) for (const completed of [false, true]) {
  test(`semantic failure gives the worker a repair turn before rechecking (completed=${completed}, delegated=${delegated})`, async t => {
    const { store, plan } = fixture(t, { completed, delegated });
    let workers = 0, verifiers = 0;
    const runner = createGoalRunner({ goalPlanStore: store, logger: { warn() {} },
      chatRuntime: { async runGoalTurn({ plan: current }) {
        workers++;
        if (workers > (completed ? 0 : 1)) {
          assert.equal(current.runner.phase, 'repair');
          assert.equal(current.runner.intent, 'execute');
          assert.equal(current.runner.verifierRuns.find(run => run.report?.failedCriteria?.length)?.report.failedCriteria[0].reason, 'Repository identity missing');
        }
        store.recordTaskEvidence(plan.planId, 'read', { status: 'completed',
          result: `Report revision ${workers}`, evidenceRefs: ['tool-result://read'] });
        return { completed: true, toolCallCount: 1 };
      } },
      verifierRunner: { async runVerifier() { return ++verifiers === 1 ? fail : pass; } } });
    await runner.start(plan.planId, { awaitIdle: true });
    assert.equal(store.getPlan(plan.planId).runner.status, 'completed');
    assert.equal(workers, completed ? 1 : 2);
    assert.equal(verifiers, 2, 'one independent review per attempt');
    assert.equal(store.getPlan(plan.planId).modelReviews.at(-1).passed, true);
  });
}

test('mechanical gaps are repaired with real indexed results before completion', async t => {
  const { store, plan } = fixture(t, { mechanical: true });
  let workers = 0, verifiers = 0;
  const runner = createGoalRunner({ goalPlanStore: store, logger: { warn() {} },
    chatRuntime: { async runGoalTurn({ plan: current }) {
      workers++;
      store.recordTaskEvidence(plan.planId, 'read', { status: 'completed', result: 'Read project', evidenceRefs: ['tool-result://read'] });
      if (workers === 2) {
        assert.equal(current.runner.phase, 'repair');
        store.recordCriterionResults(plan.planId, [{ criterionId: 'c1', passed: true, evidenceRef: 'tool-result://read' }]);
      }
      return { completed: true, toolCallCount: 1 };
    } }, verifierRunner: { async runVerifier() { verifiers++; return pass; } } });
  await runner.start(plan.planId, { awaitIdle: true });
  assert.equal(workers, 2);
  assert.equal(verifiers, 1, 'do not ask a semantic verifier to override mechanical gaps');
  assert.equal(store.getPlan(plan.planId).runner.status, 'completed');
});

test('persistent rejection stops after bounded repair and explicit resume actually runs the worker', async t => {
  const { store, plan } = fixture(t);
  let workers = 0, verifiers = 0, repaired = false;
  const runner = createGoalRunner({ goalPlanStore: store, logger: { warn() {} },
    chatRuntime: { async runGoalTurn() {
      workers++;
      store.recordTaskEvidence(plan.planId, 'read', { status: 'completed', result: `Report ${workers}`, evidenceRefs: ['tool-result://read'] });
      return { completed: true, toolCallCount: 1 };
    } }, verifierRunner: { async runVerifier() { verifiers++; return repaired ? pass : fail; } } });
  await runner.start(plan.planId, { awaitIdle: true });
  const blocked = store.getPlan(plan.planId);
  assert.equal(blocked.runner.status, 'blocked');
  assert.equal(blocked.status, 'executing');
  assert.equal(workers, 3, 'initial work and two repair turns');
  assert.equal(verifiers, 3, 'do not run duplicate checks on the same attempt');
  repaired = true;
  await runner.resume(plan.planId, { awaitIdle: true });
  assert.equal(workers, 4, 'continue must not immediately re-enter the failed gate');
  assert.equal(store.getPlan(plan.planId).runner.status, 'completed');
});

for (const reason of ['verification_gate_failed', 'verifier_failed']) {
  test(`active ${reason} repair survives hard writes, progress overlays and flush`, t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { store, plan } = fixture(t, { completed: true });
    store.setRunnerState(plan.planId, { enabled: true, status: 'running', phase: 'repair', intent: 'execute',
      blockerAudit: { fingerprint: `repair:${reason}`, reason, occurrences: 1 } });
    const assertRepair = saved => {
      assert.equal(saved.status, 'executing');
      assert.equal(saved.runner.status, 'running');
      assert.equal(saved.runner.phase, 'repair');
    };
    assertRepair(store.getPlan(plan.planId));
    assertRepair(store.setRunnerState(plan.planId, { toolCallCount: 2 }));
    t.mock.timers.tick(1500);
    const saved = JSON.parse(readFileSync(path.join(store.getStoreDir(), `${plan.planId}.json`), 'utf8'));
    assertRepair(saved);
    assertRepair(createGoalPlanStore({ storeDir: store.getStoreDir() }).getPlan(plan.planId));
    assertRepair(store.recordTaskEvidence(plan.planId, 'read', { result: 'Repair findings', evidenceRefs: ['tool-result://read'] }));
    store.setRunnerState(plan.planId, { enabled: false, status: 'completed', phase: 'synthesize' });
    assert.equal(store.getPlan(plan.planId).status, 'completed');
  });
}

test('a verifier permission refusal stops without spending automatic worker repair turns', async t => {
  const { store, plan } = fixture(t);
  let workers = 0, verifiers = 0;
  const runner = createGoalRunner({ goalPlanStore: store, logger: { warn() {} },
    chatRuntime: { async runGoalTurn() {
      workers++;
      store.recordTaskEvidence(plan.planId, 'read', { status: 'completed', result: 'Report', evidenceRefs: ['tool-result://read'] });
      return { completed: true };
    } }, verifierRunner: { async runVerifier() { verifiers++; throw new Error('Verifier permission denied'); } } });
  await runner.start(plan.planId, { awaitIdle: true });
  assert.equal(workers, 1);
  assert.equal(verifiers, 1);
  assert.equal(store.getPlan(plan.planId).runner.status, 'blocked');
  assert.equal(store.getPlan(plan.planId).status, 'executing');
});

for (const action of ['pause', 'clear']) {
  test(`${action} while the verifier is running prevents completion and automatic repair`, async t => {
    const { store, plan } = fixture(t);
    let release, started;
    const events = [];
    const reviewing = new Promise(resolve => { started = resolve; });
    const runner = createGoalRunner({ goalPlanStore: store, logger: { warn() {} }, emitEvent: event => events.push(event),
      chatRuntime: { async runGoalTurn() {
        store.recordTaskEvidence(plan.planId, 'read', { status: 'completed', result: 'Report', evidenceRefs: ['tool-result://read'] });
        return { completed: true };
      } }, verifierRunner: { async runVerifier() {
        started(); return await new Promise(resolve => { release = resolve; });
      } } });
    const pending = runner.start(plan.planId, { awaitIdle: true });
    await reviewing;
    runner[action](plan.planId);
    const suspended = store.getPlan(plan.planId);
    release(fail);
    await pending;
    assert.equal(store.getPlan(plan.planId).runner.status, action === 'pause' ? 'paused' : 'idle');
    assert.equal(store.getPlan(plan.planId).status, suspended.status);
    assert.equal(events.some(event => event.type === 'goalRunner:completed'), false);
    assert.equal(store.getPlan(plan.planId).modelReviews.at(-1).passed, false);
  });
}


test('restarting a host with active verification repair grants a worker turn before checking again', async t => {
  const { store, plan } = fixture(t, { completed: true, delegated: true });
  store.setRunnerState(plan.planId, { enabled: true, status: 'running', phase: 'repair', intent: 'execute',
    blockerAudit: { fingerprint: 'repair:verifier_failed', reason: 'verifier_failed', occurrences: 1 } });
  const reopened = createGoalPlanStore({ storeDir: store.getStoreDir() });
  let workers = 0;
  const runner = createGoalRunner({ goalPlanStore: reopened, logger: { warn() {} },
    chatRuntime: { async runGoalTurn({ plan: current }) {
      workers++;
      assert.equal(current.status, 'executing');
      assert.equal(current.runner.phase, 'repair');
      reopened.recordTaskEvidence(plan.planId, 'read', { status: 'completed', result: 'Corrected report', evidenceRefs: ['tool-result://read'] });
      return { completed: true };
    } }, verifierRunner: { async runVerifier() { assert.equal(workers, 1); return pass; } } });
  await runner.start(plan.planId, { awaitIdle: true });
  assert.equal(workers, 1);
  assert.equal(reopened.getPlan(plan.planId).runner.status, 'completed');
});
