import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGoalPlanStore } from './goal-plan-store.mjs';
import { createGoalRunner } from './goal-runner.mjs';
import { createGoalVisualVerification } from '../../../../packages/runtime-node/src/goal-visual-verification.mjs';
import { buildGoalRunnerTickMessage, describeVisualRepair } from '../../../../packages/runtime-node/src/goal-visual-repair.mjs';

for (const entry of ['after-turn', 'completed-at-start', 'completed-in-pump']) {
  for (const scenario of ['valid', 'self-reported', 'failed', 'stale-after-review', 'stale-during-evidence', 'mechanical-missing', 'manual-missing', 'ui-plus-manual', 'non-ui', 'pause', 'clear', 'pause-during-evidence', 'clear-during-evidence']) {
    test(`${entry}/${scenario}/visual-verifier-order`, async t => {
      if (entry === 'completed-at-start' && scenario.endsWith('-during-evidence')) {
        // Completed-plan reuse intentionally does not rerun the legacy text verifier.
        t.skip('Completed-plan reuse has no subsequent text-verifier stage'); return;
      }
      const root = mkdtempSync(path.join(os.tmpdir(), 'peer-visual-gate-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const store = createGoalPlanStore({ storeDir: root });
      const criteria = scenario === 'mechanical-missing' ? [{ id: 'build', kind: 'test', command: 'test' }]
        : ['manual-missing', 'ui-plus-manual'].includes(scenario) ? [{ id: 'accept', kind: 'manual', description: 'User confirms' }] : [];
      const create = scenario === 'manual-missing' ? store.createGoalContract : store.createPlan;
      const plan = create({ conversationId: 'test', title: 'Visual order', goal: 'Verify UI',
        successCriteria: criteria,
        ...(scenario === 'ui-plus-manual' ? { workflowKind: 'goal_self_driven' } : {}),
        tasks: [{ taskId: 'change', title: 'Change', status: 'pending', evidenceRefs: [] }] });
      if (!['manual-missing', 'ui-plus-manual'].includes(scenario)) {
        store.recordApproval(plan.planId, { decision: 'approve', decidedBy: 'test' });
      }
      const r = { id: 'layout', host: 'desktop', requirementRevision: '1', buildFingerprint: 'build', instanceId: 'preview' };
      let judgment = false; let stale = false; let visualCalls = 0; let turns = 0; let signal;
      const authority = { read() { return ['non-ui', 'manual-missing'].includes(scenario) ? { required: false } : { required: true,
        requirements: [{ ...r, buildFingerprint: stale ? 'new-build' : 'build' }],
        observations: [{ ...r, requirementId: r.id, evidenceRef: 'image', artifactHash: 'hash', admittedToRunId: judgment ? 'review' : '' }],
        judgments: judgment ? [{ requirementId: r.id, observationRef: 'image', evidenceRef: 'judgment', modelRunId: 'review',
          decision: scenario === 'failed' ? 'failed' : 'passed' }] : [] }; } };
      function finishTask() {
        store.recordEvidenceRefs({ planId: plan.planId, conversationId: plan.conversationId, evidenceRefs: ['mechanical', 'image', 'judgment'] });
        store.recordTaskEvidence(plan.planId, 'change', { status: 'completed', evidenceRefs: ['mechanical'] });
      }
      let runner;
      runner = createGoalRunner({ goalPlanStore: store, uiDeliveryAuthority: authority,
        verifierRunner: { async runVerifier(args) {
          if (args.stage !== 'visual') {
            if (scenario === 'stale-during-evidence') stale = true;
            if (scenario === 'pause-during-evidence') runner.pause(plan.planId);
            if (scenario === 'clear-during-evidence') runner.clear(plan.planId);
            return { passed: true, evidenceRefs: ['mechanical'] };
          }
          visualCalls++; signal = args.signal;
          assert.equal(args.gate.passed, false);
          assert.ok(args.gate.unmet.some(x => x.kind === 'ui_delivery'));
          if (scenario === 'ui-plus-manual') {
            assert.ok(args.gate.unmet.some(x => x.kind === 'manual' || x.reason === 'manual_confirmation_required'));
          } else {
            assert.ok(args.gate.unmet.every(x => x.kind === 'ui_delivery'));
          }
          if (scenario === 'pause' || scenario === 'clear') {
            runner[scenario](plan.planId);
            await Promise.resolve();
            assert.equal(signal.aborted, true);
            return { passed: true, evidenceRefs: ['judgment'] };
          }
          if (scenario !== 'self-reported') judgment = true;
          if (scenario === 'stale-after-review') stale = true;
          if (scenario === 'failed') {
            return { passed: false, verdict: 'failed', scene: 'background-runtime',
              artifactRef: 'local-desktop-preview-artifact://panel', evidenceRefs: ['judgment'],
              findings: ['Header is missing'], repairSuggestions: ['Keep the header visible'] };
          }
          return { passed: true, evidenceRefs: ['judgment'] };
        } },
        chatRuntime: { async runGoalTurn({ plan: current }) {
          turns++;
          if (scenario === 'failed') {
            assert.equal(current.runner.phase, 'repair');
            assert.equal(current.runner.visualRepair.feedback.verdict, 'failed');
            assert.match(JSON.stringify(current.runner.visualRepair), /Header is missing/);
            const brief = describeVisualRepair(current);
            const tick = buildGoalRunnerTickMessage(current, turns);
            for (const text of [brief, tick]) {
              assert.match(text, /background-runtime/);
              assert.match(text, /Header is missing/);
              assert.match(text, /Keep the header visible/);
              assert.match(text, /Do not claim completion from this text/);
              assert.equal(text.includes('LOCAL FIXTURE ONLY'), false);
              assert.equal(text.includes('judgment:not-evaluated'), false);
            }
            return {};
          }
          finishTask();
          return {};
        } },
      });
      if (entry !== 'after-turn' || scenario === 'failed') {
        finishTask();
        if (entry === 'completed-at-start') store.setRunnerState(plan.planId, { status: 'completed', enabled: false, intent: 'synthesize' });
        store.setPlanStatus(plan.planId, entry === 'completed-at-start' ? 'completed' : 'executing');
        assert.equal(store.getPlan(plan.planId).status, entry === 'completed-at-start' ? 'completed' : 'executing');
      }
      await runner.start(plan.planId, { awaitIdle: true });
      const got = store.getPlan(plan.planId);
      const shouldComplete = ['valid', 'non-ui'].includes(scenario);
      const shouldRepair = scenario === 'failed';
      assert.equal(got.runner.status === 'completed', shouldComplete);
      assert.equal(visualCalls, ['mechanical-missing', 'manual-missing', 'non-ui'].includes(scenario) ? 0 : (shouldRepair ? 3 : 1),
        shouldRepair ? JSON.stringify({ status: got.status, runner: got.runner, visualCalls, turns }) : undefined);
      assert.equal(turns, shouldRepair ? 2 : (entry === 'after-turn' ? 1 : 0));
      if (shouldRepair) {
        assert.equal(got.runner.status, 'blocked');
        assert.equal(got.runner.blockedReason, 'visual_repair_exhausted');
        assert.equal(got.runner.visualRepair.attempts, 2);
        assert.equal(got.runner.visualRepair.maxAttempts, 2);
        assert.equal(got.runner.visualRepair.feedback.verdict, 'failed');
        assert.notEqual(got.runner.status, 'completed');
      }
      if (scenario.startsWith('pause')) assert.equal(got.runner.status, 'paused');
      if (scenario.startsWith('clear')) { assert.equal(got.status, 'cancelled'); assert.equal(got.runner.status, 'idle'); }
      if (scenario.includes('-during-evidence') && scenario !== 'stale-during-evidence') assert.equal(signal.aborted, true);
      if (scenario === 'valid') { runner.pause(plan.planId); assert.equal(signal.aborted, true, 'pause after review revokes it'); }
    });
  }
}

for (const reason of ['preview-source-stale', 'visual-review-service-unavailable', 'visual-review-current-image-missing', 'visual-request-review-pending']) {
  test(`after-turn/${reason}/host-review-is-not-stream-error`, async t => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'peer-visual-stale-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const store = createGoalPlanStore({ storeDir: root });
    const plan = store.createPlan({ conversationId: 'test', title: 'Visual order', goal: 'Verify UI',
      tasks: [{ taskId: 'change', title: 'Change', status: 'pending', evidenceRefs: [] }] });
    store.recordApproval(plan.planId, { decision: 'approve', decidedBy: 'test' });
    const r = { id: 'layout', host: 'desktop', requirementRevision: '1', buildFingerprint: 'build', instanceId: 'preview' };
    const runner = createGoalRunner({
      goalPlanStore: store,
      uiDeliveryAuthority: { read: () => ({ required: true, requirements: [r],
        observations: [{ ...r, requirementId: r.id, evidenceRef: 'image', artifactHash: 'hash', admittedToRunId: '' }],
        judgments: [] }) },
      verifierRunner: { async runVerifier(args) {
        if (args.stage !== 'visual') return { passed: true, evidenceRefs: ['mechanical'] };
        throw new Error(reason);
      } },
      chatRuntime: { async runGoalTurn() {
        store.recordEvidenceRefs({ planId: plan.planId, conversationId: 'test', evidenceRefs: ['image'] });
        store.recordTaskEvidence(plan.planId, 'change', { status: 'completed', evidenceRefs: ['image'] });
        return { terminalStatus: 'done', completed: true, toolCallCount: 1 };
      } },
    });
    await runner.start(plan.planId, { awaitIdle: true });
    const got = store.getPlan(plan.planId);
    assert.notEqual(got.runner?.interruption?.source, 'stream_error', JSON.stringify(got.runner));
    assert.notEqual(got.status, 'completed');
    assert.equal(got.runner?.status, 'blocked');
  });
}

test('after-turn/runGoalTurn-stale/host-review-is-not-stream-error', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-visual-turn-stale-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createGoalPlanStore({ storeDir: root });
  const plan = store.createPlan({ conversationId: 'test', title: 'Visual order', goal: 'Verify UI',
    tasks: [{ taskId: 'change', title: 'Change', status: 'pending', evidenceRefs: [] }] });
  store.recordApproval(plan.planId, { decision: 'approve', decidedBy: 'test' });
  const runner = createGoalRunner({
    goalPlanStore: store,
    uiDeliveryAuthority: { read: () => ({ required: true, requirements: [], observations: [], judgments: [] }) },
    chatRuntime: { async runGoalTurn() { throw new Error('preview-source-stale'); } },
  });
  await runner.start(plan.planId, { awaitIdle: true });
  const got = store.getPlan(plan.planId);
  assert.notEqual(got.runner?.interruption?.source, 'stream_error', JSON.stringify(got.runner));
  assert.equal(got.runner?.status, 'failed');
  assert.match(got.runner?.lastError || '', /preview-source-stale/);
});

test('visual verifier timeout is bounded and cannot use a late success', async () => {
  let late;
  const plan = { planId: 'p', status: 'executing' };
  const gate = { passed: false, unmet: [{ kind: 'ui_delivery' }] };
  const records = [];
  const module = createGoalVisualVerification({ goalPlanStore: { getPlan: () => plan, recordVerifierRun: (_, r) => records.push(r) },
    verifierRunner: { runVerifier: () => new Promise(resolve => { late = resolve; }) }, evaluateGate: () => gate, timeoutMs: 10 });
  const result = await module.review(plan, gate);
  assert.equal(result.cancelled, undefined); assert.equal(result.gate.passed, false);
  assert.equal(records.at(-1).status, 'failed');
  late({ passed: true }); await Promise.resolve();
  assert.equal(records.at(-1).status, 'failed');
});
