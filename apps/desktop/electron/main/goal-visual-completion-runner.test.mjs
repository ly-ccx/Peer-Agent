import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGoalPlanStore, createGoalRunner } from '@peer-agent/runtime-node';
import { createGoalVisualCompletionHandoff } from './goal-visual-completion-handoff.mjs';

// Deterministic host/Runner integration, not a live vision-model acceptance test.
for (const activation of ['intake', 'accepted_goal']) {
  for (const scenario of ['passed', 'failed-repair-passed', 'stale', 'self-reported', 'missing-image', 'unavailable']) {
    test(`${activation}/${scenario}/foreground-completion-gate`, async t => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'peer-completion-handoff-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      let authority;
      const store = createGoalPlanStore({ storeDir: root,
        readUiDelivery: plan => authority?.read(plan.planId, plan) });
      const closeLeaf = { taskId: 'close-and-conclude', title: 'Close preview' };
      const plan = activation === 'intake'
        ? store.createIntakeContract({ conversationId: 'c', goal: 'Observe and verify panel',
          tasks: [{ taskId: 'observe', title: 'Observe panel' }, closeLeaf] })
        : store.createGoalContract({ conversationId: 'c', goal: 'Observe and verify panel',
          tasks: [{ taskId: 'observe', title: 'Observe panel' }, closeLeaf] });
      store.recordEvidenceRefs({ planId: plan.planId, conversationId: 'c', evidenceRefs: ['image', 'mechanical', 'judgment'] });
      store.recordTaskEvidence(plan.planId, 'observe', { status: 'completed', evidenceRefs: ['image'] });
      store.recordTaskEvidence(plan.planId, 'close-and-conclude', {
        status: 'waiting_user', blockedReason: 'preview-review-pending', result: 'preview-review-pending',
      });
      assert.equal(store.getPlan(plan.planId).status, 'executing', 'leaves alone cannot complete a UI plan');
      const r = { id: 'panel', host: 'desktop', requirementRevision: '1', buildFingerprint: 'build', instanceId: 'preview' };
      let decision = null; let observed = 1; let visualCalls = 0; let repairTurns = 0; let starts = 0; let closeTurns = 0;
      const order = [];
      let finishReview;
      const reviewPending = new Promise(resolve => { finishReview = resolve; });
      authority = { read: () => ({ required: true, requirements: [r],
        observations: [{ ...r, buildFingerprint: scenario === 'stale' ? 'old' : 'build',
          requirementId: r.id, evidenceRef: 'image', artifactHash: `image-${observed}`, admittedToRunId: decision ? 'review' : '' }],
        judgments: decision ? [{ requirementId: r.id, observationRef: 'image', evidenceRef: 'judgment',
          modelRunId: 'review', decision }] : [],
      }) };
      const runner = createGoalRunner({ goalPlanStore: store, uiDeliveryAuthority: authority,
        verifierRunner: { async runVerifier(args) {
          if (args.stage !== 'visual') return { passed: true, evidenceRefs: ['mechanical'] };
          visualCalls++; order.push(`review:${observed}`);
          assert.equal(args.gate.passed, false);
          await reviewPending;
          if (scenario === 'missing-image') throw new Error('visual-review-current-image-missing');
          if (scenario === 'unavailable') throw new Error('visual-review-service-unavailable');
          if (scenario === 'self-reported' || scenario === 'stale') return { passed: true, evidenceRefs: ['judgment'] };
          decision = scenario === 'failed-repair-passed' && observed === 1 ? 'failed' : 'passed';
          return { passed: decision === 'passed', verdict: decision, scene: 'background-runtime',
            artifactRef: `local-desktop-preview-artifact://panel-${observed}`, evidenceRefs: ['judgment'],
            findings: decision === 'failed' ? ['Header is missing'] : [], repairSuggestions: ['Repair and observe again'] };
        } },
        chatRuntime: { async runGoalTurn({ plan: current }) {
          assert.notEqual(current.status, 'completed', 'review alone must not finish the close task');
          if (decision === 'passed') {
            closeTurns++; order.push('close');
            assert.equal(current.tasks.find(task => task.taskId === 'close-and-conclude').status, 'pending');
            store.recordEvidenceRefs({ planId: plan.planId, conversationId: 'c', evidenceRefs: ['close-receipt'] });
            store.recordTaskEvidence(plan.planId, 'close-and-conclude', { status: 'completed', evidenceRefs: ['close-receipt'] });
            return { terminalStatus: 'done', completed: true, toolCallCount: 1 };
          }
          repairTurns++; order.push('repair');
          assert.equal(current.runner.phase, 'repair');
          assert.equal(current.runner.visualRepair.attempts, 1);
          assert.equal(current.activation.kind, activation);
          // Simulate the existing observe provider revoking the old judgment.
          decision = null; observed++; order.push(`observe:${observed}`);
          return { terminalStatus: 'done', completed: true, toolCallCount: 1 };
        } },
      });
      const service = createGoalVisualCompletionHandoff({ goalPlanStore: store, authority,
        forceComplete: () => ({ released: Promise.resolve().then(() => order.push('released')) }),
        startRunner: id => { starts++; return runner.start(id, { awaitIdle: true }); },
      });
      const pending = service.handoff('c', { terminalStatus: 'done' }, plan.planId);
      for (let i = 0; i < 80 && !visualCalls; i++) await new Promise(resolve => setTimeout(resolve, 2));
      assert.equal(visualCalls, 1);
      // Existing auto-start may kick again while the first visual review awaits I/O.
      const secondKick = runner.start(plan.planId);
      await new Promise(resolve => setTimeout(resolve, 5));
      const concurrentCalls = visualCalls;
      finishReview();
      const [handedOff] = await Promise.all([pending, secondKick]);
      assert.equal(handedOff, true);
      assert.equal(concurrentCalls, 1, 'concurrent start must not duplicate visual review');
      const got = store.getPlan(plan.planId);
      assert.ok(got, 'UI repair must not delete an intake as pure Q&A');
      assert.equal(got.activation.kind, activation, 'no silent promotion');
      assert.equal(starts, 1);
      assert.equal(visualCalls, scenario === 'failed-repair-passed' ? 2 : 1);
      assert.equal(repairTurns, scenario === 'failed-repair-passed' ? 1 : 0);
      assert.equal(order[0], 'released');
      if (scenario === 'passed' || scenario === 'failed-repair-passed') {
        assert.equal(closeTurns, 1, 'a passing review must execute close, not skip the leaf');
        assert.equal(got.status, 'completed');
        assert.deepEqual(got.tasks.find(task => task.taskId === 'close-and-conclude').evidenceRefs, ['close-receipt']);
        assert.deepEqual(order, repairTurns
          ? ['released', 'review:1', 'repair', 'observe:2', 'review:2', 'close']
          : ['released', 'review:1', 'close']);
        const verifiedCalls = visualCalls;
        await service.handoff('c', { terminalStatus: 'done' }, plan.planId);
        assert.equal(visualCalls, verifiedCalls, 'current authority pass must not request another review');
      } else {
        assert.equal(closeTurns, 0, 'invalid review cannot release close');
        assert.notEqual(got.status, 'completed');
        assert.equal(got.runner.status, 'blocked');
      }
    });
  }
}
