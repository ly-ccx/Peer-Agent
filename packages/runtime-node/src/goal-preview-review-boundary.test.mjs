import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGoalPlanStore, goalPlanWaitsOnPreviewReview } from './goal-plan-store.mjs';
import { createGoalRunner, evaluateVerificationGate } from './goal-runner.mjs';
import { shouldAutoStartAcceptedGoalRunner } from './goal-intake-convergence.mjs';

const pending = { status: 'waiting_user', blockedReason: 'preview-review-pending' };

for (const ui of ['non-ui', 'passed']) {
  test(`completion/${ui}/preview-leaf-still-needs-evidence`, () => {
    const plan = { tasks: [{ taskId: 'close', ...pending }] };
    const r = { id: 'panel', host: 'desktop', requirementRevision: '1', buildFingerprint: 'build', instanceId: 'preview' };
    const gate = evaluateVerificationGate(plan, ui === 'non-ui' ? {} : {
      indexedEvidenceRefs: ['image', 'judgment'], uiDeliveryRequired: true, uiDelivery: { requirements: [r],
        observations: [{ ...r, requirementId: r.id, evidenceRef: 'image', artifactHash: 'hash', admittedToRunId: 'review' }],
        judgments: [{ requirementId: r.id, observationRef: 'image', evidenceRef: 'judgment', modelRunId: 'review', decision: 'passed' }] },
    });
    assert.equal(gate.unmet.some(item => item.kind === 'ui_delivery'), false);
    assert.equal(gate.passed, false);
    assert.ok(gate.unmet.some(item => item.taskId === 'close' && item.reason === 'not_completed'));
  });
}

for (const entry of ['before-start', 'after-turn']) {
  for (const wait of ['preview-only', 'requested-input', 'mixed-user-leaf']) {
    test(`${entry}/${wait}/review-or-user-wait`, async t => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'peer-review-boundary-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const store = createGoalPlanStore({ storeDir: root });
      const plan = store.createGoalContract({ conversationId: 'c', goal: 'Review then close',
        tasks: [{ taskId: 'observe', title: 'Observe' }, { taskId: 'close', title: 'Close' },
          ...(wait === 'mixed-user-leaf' ? [{ taskId: 'question', title: 'Choose destination' }] : [])] });
      store.recordEvidenceRefs({ planId: plan.planId, conversationId: 'c', evidenceRefs: ['image'] });
      store.recordTaskEvidence(plan.planId, 'observe', { status: 'completed', evidenceRefs: ['image'] });
      const arrangeWait = () => {
        store.recordTaskEvidence(plan.planId, 'close', pending);
        if (wait === 'mixed-user-leaf') store.recordTaskEvidence(plan.planId, 'question', {
          status: 'waiting_user', blockedReason: 'choose_destination',
        });
      };
      if (entry === 'before-start') {
        arrangeWait();
        if (wait === 'requested-input') store.markRequestedUserInput(plan.planId);
      }
      let turns = 0; let reviews = 0;
      const runner = createGoalRunner({ goalPlanStore: store, logger: { warn() {} }, maxTurns: 3,
        uiDeliveryAuthority: { read: () => ({ required: true, requirements: [{ id: 'panel' }], observations: [], judgments: [] }) },
        verifierRunner: { async runVerifier({ stage }) {
          if (stage === 'visual') reviews++;
          throw new Error('preview-image-missing');
        } },
        chatRuntime: { async runGoalTurn() {
          turns++;
          assert.equal(entry, 'after-turn', 'automatic kick must not cross user wait');
          assert.equal(turns, 1, 'no extra turn while waiting');
          arrangeWait();
          return { terminalStatus: 'done', toolCallCount: 1, requestedUserInput: wait === 'requested-input' };
        } },
      });
      await runner.start(plan.planId, { awaitIdle: true });
      assert.equal(reviews, wait === 'preview-only' ? 1 : 0);
      assert.equal(turns, entry === 'after-turn' ? 1 : 0);
      const current = store.getPlan(plan.planId);
      assert.notEqual(current.status, 'completed');
      if (wait !== 'preview-only') {
        assert.equal(current.runner.status, 'waiting_user');
        assert.equal(shouldAutoStartAcceptedGoalRunner(current), false);
        await runner.start(plan.planId, { awaitIdle: true });
        assert.equal(reviews, 0, 'subsequent kick must also stay parked');
      }
    });
  }
}

for (const extra of ['only-close-pending', 'close-plus-manual', 'close-plus-sibling-pending']) {
  test(`passed-review/${extra}/must-execute-close`, async t => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'peer-review-close-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const r = { id: 'panel', host: 'desktop', requirementRevision: '1', buildFingerprint: 'build', instanceId: 'preview' };
    const store = createGoalPlanStore({ storeDir: root, readUiDelivery: () => ({
      required: true, requirements: [r],
      observations: [{ ...r, requirementId: r.id, evidenceRef: 'image', artifactHash: 'hash', admittedToRunId: 'review' }],
      judgments: [{ requirementId: r.id, observationRef: 'image', evidenceRef: 'judgment', modelRunId: 'review', decision: 'passed' }],
    }) });
    const tasks = [{ taskId: 'observe', title: 'Observe' }, { taskId: 'close', title: 'Close' }];
    if (extra === 'close-plus-sibling-pending') tasks.push({ taskId: 'fix-once', title: 'Repair if needed' });
    const plan = extra === 'close-plus-manual'
      ? store.createGoalContract({ conversationId: 'c', goal: 'Review then close', tasks,
        successCriteria: [{ id: 'human', kind: 'manual', description: 'Final human check' }] })
      : store.createGoalContract({ conversationId: 'c', goal: 'Review then close', tasks });
    store.recordEvidenceRefs({ planId: plan.planId, conversationId: 'c', evidenceRefs: ['image', 'judgment'] });
    store.recordTaskEvidence(plan.planId, 'observe', { status: 'completed', evidenceRefs: ['image'] });
    store.recordTaskEvidence(plan.planId, 'close', pending);
    let closeTurns = 0;
    const runner = createGoalRunner({ goalPlanStore: store, logger: { warn() {} }, maxTurns: 3,
      uiDeliveryAuthority: { read: () => ({ required: true, requirements: [r],
        observations: [{ ...r, requirementId: r.id, evidenceRef: 'image', artifactHash: 'hash', admittedToRunId: 'review' }],
        judgments: [{ requirementId: r.id, observationRef: 'image', evidenceRef: 'judgment', modelRunId: 'review', decision: 'passed' }] }) },
      verifierRunner: { async runVerifier() { return { passed: true, evidenceRefs: ['judgment'] }; } },
      chatRuntime: { async runGoalTurn({ plan: current }) {
        const close = current.tasks.find(task => task.taskId === 'close');
        assert.equal(close.status, 'pending', 'passed review must release close');
        closeTurns += 1;
        store.recordEvidenceRefs({ planId: plan.planId, conversationId: 'c', evidenceRefs: ['close-receipt'] });
        store.recordTaskEvidence(plan.planId, 'close', { status: 'completed', evidenceRefs: ['close-receipt'] });
        return { terminalStatus: 'done', completed: true, toolCallCount: 1 };
      } },
    });
    await runner.start(plan.planId, { awaitIdle: true });
    assert.equal(closeTurns, 1);
    assert.equal(store.getPlan(plan.planId).tasks.find(task => task.taskId === 'close').status, 'completed');
  });
}

test('persisted-request/preview-leaf/cannot-auto-start', () => {
  const plan = { workflowKind: 'goal_self_driven', activation: { kind: 'accepted_goal' }, status: 'executing',
    runner: { status: 'waiting_user', blockedReason: 'requested_user_input' }, tasks: [pending] };
  assert.equal(goalPlanWaitsOnPreviewReview(plan), false);
  assert.equal(shouldAutoStartAcceptedGoalRunner(plan), false);
});

// 条件叶子（“复核不通过才返工”）在复核通过后被取消，是前提不成立的跳过，不是未完成。
// 带已入索引证据的取消放行；无证据 / 证据未入索引的取消仍然拦截。
test('conditional-skip/cancelled-with-indexed-evidence/passes', () => {
  const plan = { tasks: [{ taskId: 'rework-if-failed',
    status: 'cancelled', evidenceRefs: ['visual-review://passed'] }] };
  const gate = evaluateVerificationGate(plan, { indexedEvidenceRefs: ['visual-review://passed'] });
  assert.equal(gate.unmet.length, 0);
  assert.equal(gate.passed, true);
});

test('conditional-skip/cancelled-without-evidence/blocks', () => {
  const plan = { tasks: [{ taskId: 'rework-if-failed', status: 'cancelled', evidenceRefs: [] }] };
  const gate = evaluateVerificationGate(plan);
  assert.equal(gate.passed, false);
  assert.ok(gate.unmet.some(item => item.taskId === 'rework-if-failed' && item.reason === 'cancelled_without_evidence'));
});

test('conditional-skip/cancelled-with-unindexed-evidence/blocks', () => {
  const plan = { tasks: [{ taskId: 'rework-if-failed', status: 'cancelled', evidenceRefs: ['forged://ref'] }] };
  const gate = evaluateVerificationGate(plan, { indexedEvidenceRefs: ['visual-review://passed'] });
  assert.equal(gate.passed, false);
  assert.ok(gate.unmet.some(item => item.taskId === 'rework-if-failed' && item.reason === 'unindexed_evidence'));
});

test('conditional-skip/pending-leaf/still-not-completed', () => {
  const plan = { tasks: [{ taskId: 'rework-if-failed', status: 'pending', evidenceRefs: ['visual-review://passed'] }] };
  const gate = evaluateVerificationGate(plan, { indexedEvidenceRefs: ['visual-review://passed'] });
  assert.equal(gate.passed, false);
  assert.ok(gate.unmet.some(item => item.taskId === 'rework-if-failed' && item.reason === 'not_completed'));
});

test('conditional-skip/needs-no-ui-authority', () => {
  const plan = { tasks: [{ taskId: 'rework-if-failed',
    status: 'cancelled', evidenceRefs: ['visual-review://passed'] }] };
  const gate = evaluateVerificationGate(plan, { indexedEvidenceRefs: ['visual-review://passed'],
    requireManualConfirmation: true });
  assert.equal(gate.unmet.some(item => item.kind === 'ui_delivery'), false);
});
