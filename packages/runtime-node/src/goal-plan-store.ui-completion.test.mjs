import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGoalPlanStore } from './goal-plan-store.mjs';

function fixture(t, activation = 'accepted_goal') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-ui-completion-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let mode = 'passed';
  const identity = { id: 'panel', host: 'desktop', requirementRevision: '1', buildFingerprint: 'build', instanceId: 'preview' };
  const readUiDelivery = plan => {
    assert.ok(plan.planId && plan.tasks.length, 'authority receives full host plan, not index metadata');
    if (mode === 'throws') throw new Error('authority-unavailable');
    if (mode === 'async') return Promise.resolve({ required: false });
    if (mode === 'invalid') return undefined;
    if (mode === 'non-ui') return { required: false };
    const observation = { ...identity, requirementId: identity.id, artifactHash: 'hash', evidenceRef: 'image', admittedToRunId: 'review' };
    if (mode === 'stale') observation.buildFingerprint = 'old';
    return { required: true, requirements: [{ ...identity, instanceId: mode === 'closed' ? 'closed' : 'preview' }],
      observations: [observation], judgments: mode === 'missing' ? [] : [{ requirementId: identity.id,
        observationRef: 'image', evidenceRef: 'judgment', modelRunId: 'review', decision: mode === 'failed' ? 'failed' : 'passed' }] };
  };
  const store = createGoalPlanStore({ storeDir: root, readUiDelivery });
  const plan = activation === 'intake'
    ? store.createIntakeContract({ conversationId: 'c', goal: 'Observe panel' })
    : store.createGoalContract({ conversationId: 'c', goal: 'Observe panel', tasks: [{ taskId: 'observe', title: 'Observe panel' }] });
  const id = plan.planId;
  // Match the live plan: execution had already started before the late leaf write.
  store.setPlanStatus(id, 'executing');
  store.recordEvidenceRefs({ planId: id, conversationId: 'c', evidenceRefs: ['image', 'judgment'] });
  return { root, id, store, readUiDelivery, mode: value => { mode = value; },
    finish: () => store.recordTaskEvidence(id, plan.tasks[0].taskId, { status: 'completed', evidenceRefs: ['image'] }),
    disk: () => JSON.parse(readFileSync(path.join(root, `${id}.json`), 'utf8')) };
}

for (const activation of ['intake', 'accepted_goal']) {
  for (const entry of ['leaf', 'explicit', 'overlay']) {
    for (const mode of ['passed', 'missing', 'failed', 'stale', 'closed', 'throws', 'async', 'invalid', 'non-ui']) {
      test(`${activation}/${entry}/${mode}/store-ui-completion`, t => {
        const f = fixture(t, activation);
        if (entry !== 'leaf') { f.finish(); assert.equal(f.store.getPlan(f.id).status, 'completed'); }
        f.mode(mode);
        const got = entry === 'leaf' ? f.finish() : entry === 'explicit'
          ? f.store.setPlanStatus(f.id, 'completed') : f.store.setRunnerState(f.id, { toolCallCount: 2 });
        const expected = ['passed', 'non-ui'].includes(mode) ? 'completed' : 'executing';
        assert.equal(got.status, expected);
        assert.equal(f.store.getPlan(f.id).status, expected);
        assert.equal(f.store.listPlanDetails()[0].status, expected);
        assert.equal(f.store.listPlans()[0].status, expected, 'index projection must not resurrect completion');
        if (entry !== 'overlay') assert.equal(f.disk().status, expected);
      });
    }
  }
}

for (const activation of ['intake', 'accepted_goal']) {
  test(`${activation}/late-leaf-after-stream-error/no-false-completion`, t => {
    const f = fixture(t, activation); f.mode('missing');
    f.store.setRunnerState(f.id, { status: 'failed', interruption: { source: 'stream_error',
      reason: 'observed live failure', interruptedAt: new Date().toISOString(), recoverable: false } });
    assert.equal(f.finish().status, 'interrupted');
    assert.equal(f.disk().status, 'interrupted');
    // A model-authored quality report cannot replace the host visual judgment.
    f.store.recordQualityReview(f.id, { status: 'passed', evidenceRefs: ['image'], summary: 'looks fine' });
    assert.equal(f.store.setPlanStatus(f.id, 'completed').status, 'interrupted');
    f.mode('passed');
    assert.equal(f.store.setPlanStatus(f.id, 'completed').status, 'interrupted', 'a pass must not consume an interruption');
    assert.equal(f.store.getPlan(f.id).runner.interruption.source, 'stream_error');
  });

  test(`${activation}/cold-and-cached-read/revoked-judgment`, t => {
    const f = fixture(t, activation); f.finish();
    assert.equal(f.store.listPlans()[0].status, 'completed'); // populate index cache
    f.mode('missing');
    assert.equal(f.store.getPlan(f.id).status, 'executing');
    assert.equal(f.store.listPlans()[0].status, 'executing');
    assert.equal(createGoalPlanStore({ storeDir: f.root, readUiDelivery: f.readUiDelivery }).getPlan(f.id).status, 'executing');
    assert.equal(f.disk().status, 'completed', 'read projection must not rewrite historical data');
    f.store.setRunnerState(f.id, { toolCallCount: 3 });
    f.store.setRunnerState(f.id, { status: 'idle' }); // flush pending progress through a hard write
    assert.equal(f.disk().status, 'executing');
  });
}

for (const activation of ['intake', 'accepted_goal']) {
  for (const scope of ['unindexed', 'other-plan', 'other-conversation']) {
    test(`${activation}/${scope}/judgment-evidence-scope`, t => {
      const f = fixture(t, activation);
      const store = createGoalPlanStore({ storeDir: f.root, readUiDelivery: plan => {
        const state = f.readUiDelivery(plan);
        state.judgments[0].evidenceRef = 'foreign-judgment';
        return state;
      } });
      if (scope !== 'unindexed') store.recordEvidenceRefs({
        planId: scope === 'other-plan' ? 'foreign-plan' : f.id,
        conversationId: scope === 'other-conversation' ? 'foreign-conversation' : 'c',
        evidenceRefs: ['foreign-judgment'],
      });
      f.finish();
      assert.equal(store.setPlanStatus(f.id, 'completed').status, 'executing');
    });
  }
}

for (const status of ['cancelled', 'paused', 'failed']) {
  test(`${status}/read-does-not-resume`, t => {
    const f = fixture(t); f.mode('missing');
    f.store.setPlanStatus(f.id, status);
    assert.equal(f.store.getPlan(f.id).status, status);
  });
}

for (const status of ['cancelled', 'paused']) {
  test(`${status}/runner-state-does-not-complete`, t => {
    const f = fixture(t); f.finish();
    f.store.setPlanStatus(f.id, status);
    f.store.setRunnerState(f.id, { enabled: false, status: 'idle', intent: 'block' });
    assert.equal(f.store.getPlan(f.id).status, status);
    assert.equal(f.disk().status, status);
  });
}

test('async rejected authority fails closed without an unhandled rejection', async t => {
  const f = fixture(t); f.finish();
  const store = createGoalPlanStore({ storeDir: f.root, readUiDelivery: () => Promise.reject(new Error('offline')) });
  assert.equal(store.getPlan(f.id).status, 'executing');
  await new Promise(resolve => setImmediate(resolve));
});

test('progress flush rechecks a verdict revoked after creating the overlay', async t => {
  const f = fixture(t); f.finish();
  f.store.setRunnerState(f.id, { toolCallCount: 1 });
  f.mode('missing');
  for (let i = 0; i < 40 && f.disk().status === 'completed'; i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.disk().status, 'executing');
});

test('legacy store without a UI authority keeps its completion semantics', t => {
  const f = fixture(t); const legacy = createGoalPlanStore({ storeDir: f.root });
  f.mode('missing'); f.finish();
  assert.equal(legacy.setPlanStatus(f.id, 'completed').status, 'completed');
});

for (const mode of ['passed', 'missing']) {
  test(`authority-reenter/${mode}/getPlan-must-not-recurse`, { timeout: 2000 }, t => {
    const f = fixture(t);
    f.finish();
    f.mode(mode);
    let reads = 0;
    const store = createGoalPlanStore({
      storeDir: f.root,
      readUiDelivery: (plan) => {
        reads += 1;
        assert.ok(reads < 8, 'UI projection must not recurse through getPlan');
        const nested = store.getPlan(plan.planId);
        assert.equal(nested.planId, plan.planId);
        const listed = store.listPlans();
        assert.equal(listed[0].planId, plan.planId);
        return f.readUiDelivery(plan);
      },
    });
    const started = Date.now();
    const plan = store.getPlan(f.id);
    const listed = store.listPlans();
    assert.ok(Date.now() - started < 1000, 're-entrant projection must return without spinning');
    assert.ok(reads >= 1 && reads <= 2, `projection may re-read the index, not recurse: ${reads}`);
    assert.equal(plan.status, mode === 'passed' ? 'completed' : 'executing');
    assert.equal(listed[0].status, plan.status);
  });
}

test('completed leaves settle a leftover running runner to idle', t => {
  const f = fixture(t);
  f.store.setRunnerState(f.id, {
    enabled: true,
    status: 'running',
    intent: 'execute',
    phase: 'act',
  });
  assert.equal(f.store.getPlan(f.id).runner.status, 'running');
  f.finish();
  const after = f.store.getPlan(f.id);
  assert.equal(after.status, 'completed');
  assert.equal(after.runner.status, 'idle', '计划 completed 时 runner 不得仍是 running');
});

test('interrupted plan is not washed completed by the last leaf', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-keep-interrupted-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createGoalPlanStore({ storeDir: root });
  const plan = store.createGoalContract({
    conversationId: 'c',
    goal: 'Keep interruption',
    tasks: [
      { taskId: 't1', title: 'First leaf' },
      { taskId: 't2', title: 'Second leaf' },
    ],
  });
  store.setPlanStatus(plan.planId, 'executing');
  store.recordEvidenceRefs({
    planId: plan.planId,
    conversationId: 'c',
    evidenceRefs: ['ev://1', 'ev://2'],
  });
  store.recordTaskEvidence(plan.planId, 't1', { status: 'completed', evidenceRefs: ['ev://1'] });
  store.setRunnerState(plan.planId, {
    status: 'failed',
    phase: 'blocked',
    interruption: {
      source: 'stream_error',
      reason: 'socket disconnected',
      interruptedAt: new Date().toISOString(),
    },
  });
  assert.equal(store.getPlan(plan.planId).status, 'interrupted');
  store.recordTaskEvidence(plan.planId, 't2', { status: 'completed', evidenceRefs: ['ev://2'] });
  const after = store.getPlan(plan.planId);
  assert.equal(after.status, 'interrupted', '最后一片叶子 completed 不得洗掉可恢复中断');
  assert.equal(after.runner.interruption.source, 'stream_error');
});
