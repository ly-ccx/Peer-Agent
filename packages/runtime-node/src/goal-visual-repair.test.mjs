import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGoalPlanStore } from './goal-plan-store.mjs';
import { buildGoalRunnerTickMessage, describeVisualRepair, needsIndependentVisualReview, projectVisualRepairFeedback, scheduleVisualRepair } from './goal-visual-repair.mjs';
import { createGoalVisualVerification } from './goal-visual-verification.mjs';

const uiGate = { unmet: [{ kind: 'ui_delivery' }] };
const failed = {
  passed: false,
  verdict: 'failed',
  scene: 'background-runtime',
  artifactRef: 'local-desktop-preview-artifact://panel',
  evidenceRefs: ['visual-review://req'],
  findings: ['Empty panel is missing the header'],
  repairSuggestions: ['Keep the header visible'],
};

test('self-reported passed cannot open a repair budget', () => {
  assert.equal(projectVisualRepairFeedback({ passed: true, findings: ['ignore'] }, uiGate), null);
  assert.equal(scheduleVisualRepair({}, { passed: true }, uiGate).kind, 'ineligible');
});

test('mechanical or manual gaps do not consume the visual budget', () => {
  assert.equal(scheduleVisualRepair({}, failed, { unmet: [{ kind: 'command' }] }).kind, 'ineligible');
  assert.equal(scheduleVisualRepair({}, failed, { unmet: [{ kind: 'ui_delivery' }, { kind: 'manual' }] }).kind, 'ineligible');
  assert.equal(scheduleVisualRepair({}, failed, { unmet: [{ kind: 'ui_delivery' }, { kind: 'task' }] }).kind, 'repair');
});

test('pending manual does not skip independent review when UI delivery is unmet', () => {
  assert.equal(needsIndependentVisualReview({ unmet: [{ kind: 'ui_delivery' }] }), true);
  assert.equal(needsIndependentVisualReview({ unmet: [{ kind: 'ui_delivery' }, { kind: 'manual' }] }), true);
  assert.equal(needsIndependentVisualReview({ unmet: [{ kind: 'ui_delivery' }, { reason: 'manual_confirmation_required' }] }), true);
  assert.equal(needsIndependentVisualReview({ unmet: [{ kind: 'ui_delivery' }, { kind: 'command' }] }), false);
  assert.equal(needsIndependentVisualReview({ unmet: [{ kind: 'manual' }] }), false);
  assert.equal(needsIndependentVisualReview({ unmet: [] }), false);
});

test('a UI-only failed gate can open repair without model findings', () => {
  const scheduled = scheduleVisualRepair({}, { passed: false }, { unmet: [{ kind: 'ui_delivery', reason: 'judgment-failed' }] });
  assert.equal(scheduled.kind, 'repair');
  assert.deepEqual(scheduled.visualRepair.feedback.findings, ['judgment-failed']);
});

test('failed and inconclusive consume the independent budget, not maxTurns', () => {
  let scheduled = scheduleVisualRepair({ runner: { maxTurns: 99 } }, failed, uiGate);
  assert.equal(scheduled.kind, 'repair');
  assert.equal(scheduled.visualRepair.attempts, 1);
  assert.equal(scheduled.visualRepair.maxAttempts, 2);
  scheduled = scheduleVisualRepair({ runner: { visualRepair: scheduled.visualRepair } }, { ...failed, verdict: 'inconclusive' }, uiGate);
  assert.equal(scheduled.kind, 'repair');
  assert.equal(scheduled.visualRepair.attempts, 2);
  scheduled = scheduleVisualRepair({ runner: { visualRepair: scheduled.visualRepair } }, failed, uiGate);
  assert.equal(scheduled.kind, 'exhausted');
  assert.equal(scheduled.visualRepair.attempts, 2);
});

test('the same finding does not count as progress', () => {
  const first = scheduleVisualRepair({}, failed, uiGate);
  const again = scheduleVisualRepair({ runner: { visualRepair: first.visualRepair } }, failed, uiGate);
  assert.equal(again.kind, 'repair');
  assert.equal(again.visualRepair.attempts, 2);
  const exhausted = scheduleVisualRepair({ runner: { visualRepair: again.visualRepair } }, failed, uiGate);
  assert.equal(exhausted.kind, 'exhausted');
});

test('store persists host-normalized repair and drops raw model text', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-visual-repair-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createGoalPlanStore({ storeDir: root });
  const plan = store.createPlan({ conversationId: 'c', title: 'UI', goal: 'Panel', tasks: [] });
  store.setRunnerState(plan.planId, {
    enabled: true,
    status: 'running',
    phase: 'repair',
    visualRepair: {
      attempts: 1,
      maxAttempts: 2,
      feedback: { ...failed, findings: ['  visible gap  ', 'visible gap', 'x'.repeat(400)] },
      rawModelText: 'LOCAL FIXTURE ONLY do not persist',
    },
  });
  const got = store.getPlan(plan.planId).runner.visualRepair;
  assert.equal(got.attempts, 1);
  assert.deepEqual(got.feedback.findings, ['visible gap', 'x'.repeat(240)]);
  assert.equal(JSON.stringify(got).includes('LOCAL FIXTURE ONLY'), false);
  const restored = store.getPlan(plan.planId);
  const text = describeVisualRepair(restored);
  assert.match(text, /background-runtime/);
  assert.match(text, /failed/);
  assert.match(text, /visible gap/);
  assert.match(text, /Keep the header visible/);
  assert.match(text, /Re-observe/);
  assert.match(text, /Do not claim completion from this text/);
  assert.equal(text.includes('LOCAL FIXTURE ONLY'), false);
  const tick = buildGoalRunnerTickMessage(restored, 3);
  assert.match(tick, /Goal Runner tick 3/);
  assert.match(tick, /background-runtime/);
  assert.match(tick, /visible gap/);
  assert.match(tick, /Keep the header visible/);
  assert.match(tick, /Do not claim completion from this text/);
  assert.equal(tick.includes('LOCAL FIXTURE ONLY'), false);
  store.setRunnerState(plan.planId, { visualRepair: null, status: 'running' });
  assert.equal(store.getPlan(plan.planId).runner.visualRepair, undefined);
  assert.equal(describeVisualRepair(store.getPlan(plan.planId)), '');
  assert.equal(buildGoalRunnerTickMessage(store.getPlan(plan.planId), 4).includes('Limited visual repair'), false);
});

for (const reason of ['http-426', 'current-image-missing']) {
  test(`verifier-run/${reason}/records-failure-reason`, async t => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'peer-visual-reason-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const store = createGoalPlanStore({ storeDir: root });
    const plan = store.createPlan({ conversationId: 'c', title: 'Review', goal: 'Review UI',
      tasks: [{ taskId: 'observe', title: 'Observe' }] });
    const message = reason === 'http-426' ? 'HTTP 426' : 'visual-review-current-image-missing';
    const visual = createGoalVisualVerification({
      goalPlanStore: store,
      evaluateGate: () => ({ passed: false, unmet: [{ kind: 'ui_delivery', reason: 'judgment-missing' }] }),
      verifierRunner: { async runVerifier() { throw new Error(message); } },
    });
    const result = await visual.review(store.getPlan(plan.planId), { passed: false, unmet: [{ kind: 'ui_delivery', reason: 'judgment-missing' }] });
    assert.equal(result.attempted, true);
    const run = (store.getPlan(plan.planId).runner.verifierRuns || []).find(item => String(item.verifierRunId || '').startsWith('visual-verifier:'));
    assert.equal(run?.failureReason, message);
    assert.match(run?.summary || '', new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
}
