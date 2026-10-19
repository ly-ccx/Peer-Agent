import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createGoalPlanStore } from '../goal-plan-store.mjs';
import { createWorkCoordinationStore } from './work-coordination-store.mjs';
import { createVerificationContinuationPort, validateVerificationContinuation } from './verification-continuation-port.mjs';
import { registerWorkBudget } from './work-budget.mjs';
import { criterionSourceRevision } from './criterion-review.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'review-port-'));
  const plans = createGoalPlanStore({ storeDir: path.join(root, 'plans') });
  let leased = true;
  const options = { rootDir: path.join(root, 'runtime'), workspaceId: 'w', holdsLease: () => leased, leaseEpoch: () => 'epoch' };
  const coord = createWorkCoordinationStore(options);
  coord.saveWork({ workspaceId: 'w', workId: 'work', parentConversationId: 'parent', state: 'runnable' });
  const release = registerWorkBudget('w', coord);
  t.after(() => { release(); rmSync(root, { recursive: true, force: true }); });
  const model = { providerId: 'p', modelId: 'm', modelProviderId: 'm', family: 'f' };
  const plan = plans.createPlan({ conversationId: 'child', title: 'Review', goal: 'Review', tasks: [],
    delegationOrigin: { anchorMessageId: 'u', inputId: 'i', workspaceId: 'w', sessionId: 's', parentConversationId: 'parent',
      phase: 'running', modelSelection: { worker: model, explorer: model, verifier: model, resolvedAt: new Date().toISOString() } } });
  const sourceRevision = criterionSourceRevision(plan);
  const args = { plan, goalPlanStore: plans, workId: 'work', sourceRevision, readSourceRevision: criterionSourceRevision };
  const state = { schemaVersion: 1, continuationId: 'review', planId: plan.planId, sourceRevision, modelKey: 'm', phase: 'ready',
    modelRequests: 13, toolCalls: 12, formatAttempt: 0, evidenceRefs: ['e'], deadlineAt: new Date(Date.now() + 60000).toISOString() };
  return { root, plans, coord, args, plan, state, unlease: () => { leased = false; } };
}

test('registered checkpoint and plan metadata survive fresh store instances for a legacy task without inventing a mandate', t => {
  const f = fixture(t), port = createVerificationContinuationPort(f.args);
  const ref = port.writeCheckpoint({ provider: 'test', messages: [{ role: 'tool', content: 'paired real result' }] });
  port.save({ ...f.state, checkpointRef: ref });
  const reopened = createGoalPlanStore({ storeDir: path.join(f.root, 'plans') });
  const restored = createVerificationContinuationPort({ ...f.args, plan: reopened.getPlan(f.plan.planId), goalPlanStore: reopened });
  assert.equal(restored.load().modelRequests, 13);
  assert.equal(restored.load().workId, 'work');
  assert.equal(restored.readCheckpoint(restored.load().checkpointRef).messages[0].content, 'paired real result');
  assert.equal(f.coord.read().mandates, undefined);
});

test('source drift, cancellation, lease loss and foreign budget ownership block continuations', t => {
  for (const kind of ['source', 'cancel', 'lease', 'foreign']) {
    const f = fixture(t), port = createVerificationContinuationPort(f.args);
    if (kind === 'source') f.plans.revisePlan(f.plan.planId, { goal: 'changed goal' });
    if (kind === 'cancel') f.plans.revisePlan(f.plan.planId, { delegationOrigin: { ...f.plan.delegationOrigin, cancellation: { operationId: 'stop', reason: 'stop', phase: 'completed', requestedAt: new Date().toISOString() } } });
    if (kind === 'lease') f.unlease();
    if (kind === 'foreign') f.coord.saveWork({ ...f.coord.read().works.work, parentConversationId: 'other' });
    if (kind === 'foreign') assert.throws(() => createVerificationContinuationPort(f.args));
    else assert.throws(() => port.save(f.state));
  }
});

test('corrupt continuation metadata is retained and refused rather than giving the review a new allowance', t => {
  const f = fixture(t);
  f.plans.setRunnerState(f.plan.planId, { verificationContinuation: { ...f.state, modelRequests: -1 } });
  const port = createVerificationContinuationPort({ ...f.args, plan: f.plans.getPlan(f.plan.planId) });
  assert.throws(() => port.load(), { code: 'verifier_checkpoint_unavailable' });
  assert.throws(() => validateVerificationContinuation({ ...f.state, checkpointRef: '../foreign' }));
});

test('continuation ownership reads only current work and still rejects a later stop', t => {
  const f = fixture(t);
  const fullRead = f.coord.read;
  f.coord.read = () => assert.fail('single-work ownership must not copy unrelated work');
  try {
    const port = createVerificationContinuationPort(f.args);
    port.save(f.state);
    f.coord.saveWork({ ...f.coord.readWork('work'), state: 'cancelled', stopScope: 'work' });
    assert.throws(() => port.save(f.state), /work_execution_stopped/);
  } finally { f.coord.read = fullRead; }
});
