/**
 * interrupted + waiting_user 死锁修复（PeerAgent 空回复排查）：
 *
 * 流错误打断（可恢复重试耗尽）后计划停在 interrupted，runner 停在
 * waiting_user 等最后一片验收叶子。修复前 canConsumeRequestedUserInput
 * 不认 interrupted，用户在输入框的每条回复只被 message_routed 归档，
 * runner 永远等不到验收答复；轮次没有模型调用，渲染端空 assistant 占位
 * 成为「空回复」。
 *
 * 修复语义（收窄，不代答叶子）：
 * 1. interrupted 也允许消费（gate 与 consume 同一门，goal-message-router
 *    的 consumesRequestedUserInput 复用同一个门，主进程据此走
 *    「前台模型轮次 + 恢复 runner」而不是 kick 提前返回）；
 * 2. 消费只解除 runner 停等并清掉残留中断；等待叶子由 runner 续跑后的
 *    轮次带着用户答复完成并落 Evidence——这里绝不把动作型验收伪标成
 *    completed；
 * 3. preview-review-pending 叶子不受影响，必须走 host review；
 * 4. executing 计划的既有消费语义不回退。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  canConsumeRequestedUserInput,
  createGoalPlanStore,
  goalPlanWaitsOnUser,
} from './goal-plan-store.mjs';
import { shouldResumeGoalRunnerAfterUserDecision } from './goal-intake-convergence.mjs';

function withTempHome(fn) {
  return async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'goal-wait-consume-'));
    const previous = process.env.PEER_AGENT_HOME;
    process.env.PEER_AGENT_HOME = home;
    try {
      await fn();
    } finally {
      if (previous === undefined) delete process.env.PEER_AGENT_HOME;
      else process.env.PEER_AGENT_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  };
}

/** 建一个 self-driven 计划，confirm 叶子状态由调用方给。 */
function setupPlan(store, { confirmStatus = 'completed', blockedReason } = {}) {
  const plan = store.createPlan({
    conversationId: 'wait-consume',
    title: 'interrupted 验收消费',
    goal: '验证 interrupted + waiting_user 的用户回复能消费',
    tasks: [
      { taskId: 'scan', title: '排查', status: 'completed', evidenceRefs: [] },
      {
        taskId: 'confirm',
        title: '再采样确认',
        status: confirmStatus,
        ...(blockedReason ? { blockedReason } : {}),
        evidenceRefs: [],
      },
    ],
  });
  // 升成 accepted_goal（自驱 Goal 的正式形态）；否则自动开跑闸门本来就不放行。
  store.promoteIntakeToGoal(plan.planId);
  return plan.planId;
}

/** 模拟流错误打断（重试耗尽）后的残留态：interrupted + runner 等用户。 */
function parkInterrupted(store, planId) {
  store.setPlanStatus(planId, 'interrupted');
  store.setRunnerState(planId, {
    enabled: true,
    status: 'waiting_user',
    blockedReason: 'requested_user_input',
    waitingOnUser: true,
  });
}

test('interrupted 计划：用户回复可消费，解除停等并清残留中断', withTempHome(async () => {
  const store = createGoalPlanStore();
  const planId = setupPlan(store, { confirmStatus: 'waiting_user' });
  parkInterrupted(store, planId);

  const parked = store.getPlan(planId);
  assert.equal(parked.status, 'interrupted');
  assert.equal(canConsumeRequestedUserInput(parked), true, '修复点：interrupted 也允许消费');
  assert.equal(goalPlanWaitsOnUser(parked), true);

  store.consumeRequestedUserInput(planId, {
    type: 'message_routed',
    summary: '好了',
  });

  const after = store.getPlan(planId);
  const confirmLeaf = (after.tasks || []).find((t) => t.taskId === 'confirm');
  assert.equal(confirmLeaf.status, 'waiting_user', '叶子不代答：仍由 runner 续跑用证据收尾');
  assert.equal(after.status, 'executing', 'interrupted 残留态应随消费恢复为可运行态');
  assert.equal(after.runner.blockedReason, undefined);
  assert.equal(after.runner.status, 'running');
  assert.equal(after.runner.interruption ?? null, null, '残留中断应随消费清除');
  assert.equal(
    shouldResumeGoalRunnerAfterUserDecision(after),
    true,
    '前台轮结束后 runner 应能被交还执行权',
  );
}));

test('preview-review-pending 叶子不被会话回复代答', withTempHome(async () => {
  const store = createGoalPlanStore();
  const planId = setupPlan(store, {
    confirmStatus: 'waiting_user',
    blockedReason: 'preview-review-pending: awaiting host visual review',
  });
  parkInterrupted(store, planId);

  const parked = store.getPlan(planId);
  assert.equal(canConsumeRequestedUserInput(parked), true);
  store.consumeRequestedUserInput(planId, {
    type: 'message_routed',
    summary: '好了',
  });

  const after = store.getPlan(planId);
  const confirmLeaf = (after.tasks || []).find((t) => t.taskId === 'confirm');
  assert.equal(confirmLeaf.status, 'waiting_user', '预览评审叶子必须走 host review');
  assert.equal(confirmLeaf.blockedReason, 'preview-review-pending: awaiting host visual review');
  assert.equal(after.runner.blockedReason, undefined);
}));

test('executing 计划的既有消费语义不回退', withTempHome(async () => {
  const store = createGoalPlanStore();
  const planId = setupPlan(store, { confirmStatus: 'running' });
  store.setRunnerState(planId, {
    enabled: true,
    status: 'waiting_user',
    blockedReason: 'requested_user_input',
    waitingOnUser: true,
  });

  assert.equal(canConsumeRequestedUserInput(store.getPlan(planId)), true);
  store.consumeRequestedUserInput(planId, {
    type: 'message_routed',
    summary: '继续',
  });

  const after = store.getPlan(planId);
  // 仍有未完成叶子：计划停在 executing，runner 保持 running 继续干活。
  assert.equal(after.status, 'executing');
  assert.equal(after.runner.status, 'running');
  assert.equal(after.runner.blockedReason, undefined);
  assert.equal(shouldResumeGoalRunnerAfterUserDecision(after), true);
}));

test('runner 不在等用户时不可消费', withTempHome(async () => {
  const store = createGoalPlanStore();
  const planId = setupPlan(store);
  store.setPlanStatus(planId, 'interrupted');

  assert.equal(canConsumeRequestedUserInput(store.getPlan(planId)), false);
}));
