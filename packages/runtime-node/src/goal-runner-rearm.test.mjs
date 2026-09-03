import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createGoalPlanStore } from './goal-plan-store.mjs';
import {
  shouldAutoStartAcceptedGoalRunnerFromChange,
  shouldRearmFailedGoalPlanFromChange,
} from './goal-intake-convergence.mjs';

const baseGoal = {
  title: 'Re-arm after turn-1 interruption',
  goal: 'Recover a failed accepted goal from a fresh goal-accepted change',
};

function setUpStore(t, conversationId) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-goal-rearm-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const events = [];
  const store = createGoalPlanStore({ onChange: (event) => events.push(event) });
  return { store, events, conversationId };
}

test('goal-accepted change re-arms a failed accepted_goal plan', (t) => {
  const { store, events, conversationId } = setUpStore(t, 'conv-rearm-failed');

  // 真实链路：goal 模式首答先建 intake 契约，中断后升级为 accepted_goal。
  const intake = store.createIntakeContract({ ...baseGoal, conversationId });
  // 模拟首答回合中断：convergeIntakeAfterGoalTurn 的 mark_interrupted 写入。
  store.setRunnerState(intake.planId, {
    interruption: {
      source: 'stream_interrupted',
      reason: 'error',
      interruptedAt: new Date().toISOString(),
    },
  });
  store.setPlanStatus(intake.planId, 'failed', { changedBy: 'system:test' });
  events.length = 0;

  // 用户/模型重新 goal_create_plan → upsertGoalContract 原地升级 + goal-accepted 广播。
  const upgraded = store.upsertGoalContract(conversationId, {
    ...baseGoal,
    activation: { kind: 'accepted_goal' },
    status: 'accepted',
    tasks: [{ taskId: 't1', title: 'Do the work', status: 'pending' }],
  });

  assert.equal(events.at(-1)?.changeKind, 'goal-accepted');
  assert.equal(upgraded.activation?.kind, 'accepted_goal');
  // 升级必须消费未恢复的 interruption，否则 persist 会把 accepted 派生回 failed。
  assert.equal(upgraded.runner?.interruption ?? null, null);
  assert.equal(upgraded.status, 'accepted');
  assert.equal(shouldRearmFailedGoalPlanFromChange(upgraded), false);
  assert.equal(
    shouldAutoStartAcceptedGoalRunnerFromChange(events.at(-1), upgraded),
    true,
  );
});

test('goal-accepted change re-arms an interrupted plan with a stale interruption', (t) => {
  // 当前模型把未消费 interruption 归一化为 interrupted；goal-accepted 变更仍必须
  // 能经 re-arm 闸门拉起。failed 作为升级前存量状态由上一条用例继续覆盖。
  const { store, events, conversationId } = setUpStore(t, 'conv-rearm-stale');

  const intake = store.createGoalContract({ ...baseGoal, conversationId });
  store.setRunnerState(intake.planId, {
    interruption: {
      source: 'stream_interrupted',
      reason: 'error',
      interruptedAt: new Date().toISOString(),
    },
  });
  store.setPlanStatus(intake.planId, 'failed', { changedBy: 'system:test' });

  const interruptedPlan = store.getPlan(intake.planId);
  assert.equal(interruptedPlan.status, 'interrupted');
  events.length = 0;

  const change = { changeKind: 'goal-accepted', planId: interruptedPlan.planId };
  assert.equal(shouldRearmFailedGoalPlanFromChange(interruptedPlan), true);
  assert.equal(shouldAutoStartAcceptedGoalRunnerFromChange(change, interruptedPlan), true);

  // 非 goal-accepted 变更不能 re-arm（防止 Runner 自写 persist 触发自激循环）。
  assert.equal(
    shouldAutoStartAcceptedGoalRunnerFromChange({ changeKind: 'persist' }, interruptedPlan),
    false,
  );
});

test('intake stream-error leftover waiting_user is cleared on goal-accepted so Runner can start', (t) => {
  const { store, events, conversationId } = setUpStore(t, 'conv-rearm-leftover-wait');

  const intake = store.createIntakeContract({ ...baseGoal, conversationId });
  store.setRunnerState(intake.planId, {
    interruption: {
      source: 'stream_interrupted',
      reason: 'error',
      interruptedAt: new Date().toISOString(),
    },
  });
  store.markRequestedUserInput(intake.planId);
  const leftover = store.getPlan(intake.planId);
  assert.equal(leftover.runner?.status, 'waiting_user');
  assert.equal(leftover.runner?.blockedReason, 'requested_user_input');
  assert.ok(leftover.runner?.interruption);
  events.length = 0;

  const upgraded = store.upsertGoalContract(conversationId, {
    ...baseGoal,
    activation: { kind: 'accepted_goal' },
    status: 'accepted',
    tasks: [{ taskId: 't1', title: 'Do the work', status: 'pending' }],
  });

  assert.equal(events.at(-1)?.changeKind, 'goal-accepted');
  assert.equal(upgraded.activation?.kind, 'accepted_goal');
  assert.equal(upgraded.status, 'accepted');
  assert.equal(upgraded.runner?.interruption ?? null, null);
  assert.notEqual(upgraded.runner?.status, 'waiting_user');
  assert.equal(upgraded.runner?.blockedReason ?? undefined, undefined);
  assert.equal(shouldRearmFailedGoalPlanFromChange(upgraded), false);
  assert.equal(
    shouldAutoStartAcceptedGoalRunnerFromChange(events.at(-1), upgraded),
    true,
  );
});

test('cancelled and completed plans are not re-armed', (t) => {
  const { store, conversationId } = setUpStore(t, 'conv-rearm-terminal');

  const intake = store.createGoalContract({ ...baseGoal, conversationId });
  store.setPlanStatus(intake.planId, 'cancelled', { changedBy: 'system:test' });
  assert.equal(shouldRearmFailedGoalPlanFromChange(store.getPlan(intake.planId)), false);

  store.setPlanStatus(intake.planId, 'completed', { changedBy: 'system:test' });
  assert.equal(shouldRearmFailedGoalPlanFromChange(store.getPlan(intake.planId)), false);
});
