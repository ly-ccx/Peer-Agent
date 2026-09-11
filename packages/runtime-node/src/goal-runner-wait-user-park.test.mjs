/**
 * 目标停机语义：计划里只剩等用户的叶子时，Runner 必须停在等待用户，
 * 不能被「回合结束的泵 / 会话重开恢复 / 陈旧 kick / 变更广播」再点着；
 * 同时用户回答后必须仍能续跑。
 *
 * 修复前的真实缺陷（会话 afb9f73c）：模型只调 goal_update_task(leaf -> waiting_user)
 * 而不调 request_user_input，runner 仍是 running，泵继续排空转轮次。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { canConsumeRequestedUserInput, createGoalPlanStore, goalPlanWaitsOnUser } from './goal-plan-store.mjs';
import { createGoalRunner } from './goal-runner.mjs';
import {
  isStalledAcceptedGoalRunner,
  shouldAutoStartAcceptedGoalRunnerFromChange,
  shouldRecoverAcceptedGoalRunnerOnConversationOpen,
  shouldResumeGoalRunnerAfterUserDecision,
} from './goal-intake-convergence.mjs';

function withTempHome(fn) {
  return async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'goal-park-'));
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

/** 建一个可运行的 accepted_goal，叶子状态由调用方给。 */
function setupPlan(store, leafStatuses) {
  const plan = store.createPlan({
    conversationId: 'wait-user-park',
    title: 'Fix the flaky stream',
    goal: 'Fix the flaky stream',
    tasks: Object.entries(leafStatuses).map(([taskId, status]) => ({
      taskId,
      title: taskId,
      status,
      evidenceRefs: [],
    })),
  });
  // 升成 accepted_goal（自驱 Goal 的正式形态）；否则自动开跑闸门本来就不放行，测不到本次改动。
  store.promoteIntakeToGoal(plan.planId);
  store.setRunnerState(plan.planId, {
    enabled: true,
    status: 'running',
    phase: 'act',
    intent: 'execute',
    turnCount: 0,
  });
  return plan.planId;
}

const isLeafPark = (event) => event?.payload?.source === 'leaf_waiting_user';

test('只剩等用户的叶子：回合结束停在 waiting_user，不再排下一轮空转', withTempHome(async () => {
  const store = createGoalPlanStore();
  const planId = setupPlan(store, { scan: 'completed', confirm: 'pending' });

  let calls = 0;
  const runner = createGoalRunner({
    goalPlanStore: store,
    logger: { warn() {} },
    recoverableRetryLimit: 0,
    maxTurns: 4,
    chatRuntime: {
      async runGoalTurn() {
        calls += 1;
        // 模型的真实行为：只把叶子标成等用户，没有调 request_user_input。
        store.recordTaskEvidence(planId, 'confirm', { status: 'waiting_user' });
        // toolCallCount > 0 是真实空转轮的形态（每轮都在 read_file / bash），
        // 否则会被 verbal-stop 宽限逻辑先接管，测不到本次改动。
        return { terminalStatus: 'done', continue: true, toolCallCount: 2 };
      },
    },
  });

  await runner.resume(planId, { awaitIdle: true, reason: 'goal_accepted' });

  const final = store.getPlan(planId);
  assert.equal(calls, 1, '停在等用户后不应再排下一轮');
  assert.equal(final.runner.status, 'waiting_user');
  assert.equal(final.runner.blockedReason, 'requested_user_input');
  assert.ok(final.runTrace.events.some(isLeafPark), '应留下叶子等待停机事件');
}));

test('还有可自己推进的活：不停机，继续跑', withTempHome(async () => {
  const store = createGoalPlanStore();
  const planId = setupPlan(store, { confirm: 'waiting_user', inspect: 'pending' });

  let calls = 0;
  const runner = createGoalRunner({
    goalPlanStore: store,
    logger: { warn() {} },
    recoverableRetryLimit: 0,
    maxTurns: 3,
    chatRuntime: {
      async runGoalTurn() {
        calls += 1;
        return { terminalStatus: 'done', continue: true, toolCallCount: 2 };
      },
    },
  });

  await runner.resume(planId, { awaitIdle: true, reason: 'goal_accepted' });

  const final = store.getPlan(planId);
  assert.ok(calls > 1, '还有 pending 叶子时应继续排轮次');
  assert.ok(!final.runTrace.events.some(isLeafPark), '不应误判为只剩等用户');
  assert.notEqual(final.runner.blockedReason, 'requested_user_input');
}));

test('用户回答后：能消费等待态并续跑，把剩下的活干完', withTempHome(async () => {
  const store = createGoalPlanStore();
  const planId = setupPlan(store, { scan: 'completed', confirm: 'pending' });

  let calls = 0;
  const runner = createGoalRunner({
    goalPlanStore: store,
    logger: { warn() {} },
    recoverableRetryLimit: 0,
    maxTurns: 4,
    chatRuntime: {
      async runGoalTurn() {
        calls += 1;
        if (calls === 1) {
          store.recordTaskEvidence(planId, 'confirm', { status: 'waiting_user' });
          return { terminalStatus: 'done', continue: true, toolCallCount: 2 };
        }
        // 用户已经回答了：这一轮把确认做完，正常收口。
        // 真实链路里 tool-result 会先进 EvidenceIndex，这里显式登记同一件事。
        store.recordEvidenceRefs({
          conversationId: 'wait-user-park',
          evidenceRefs: ['tool-result://user-confirmed'],
        });
        store.recordTaskEvidence(planId, 'confirm', {
          status: 'completed',
          evidenceRefs: ['tool-result://user-confirmed'],
        });
        return { terminalStatus: 'done', continue: false, toolCallCount: 1 };
      },
    },
  });

  await runner.resume(planId, { awaitIdle: true, reason: 'goal_accepted' });
  assert.equal(store.getPlan(planId).runner.status, 'waiting_user');

  // 用户回复可以消费这条等待态，且不会被「只剩等用户」的闸门反过来挡住。
  const parked = store.getPlan(planId);
  assert.equal(canConsumeRequestedUserInput(parked), true);
  store.consumeRequestedUserInput(planId, { type: 'message_routed', summary: '用户回答了确认问题' });
  const afterConsume = store.getPlan(planId);
  assert.equal(afterConsume.runner.blockedReason, undefined);
  assert.equal(shouldResumeGoalRunnerAfterUserDecision(afterConsume), true);

  await runner.resume(planId, { awaitIdle: true, reason: 'user_decision' });

  const final = store.getPlan(planId);
  assert.equal(calls, 2, '用户回答后应能续跑一轮');
  const confirmLeaf = final.tasks.find((t) => t.taskId === 'confirm');
  assert.equal(confirmLeaf.status, 'completed');
  assert.deepEqual(confirmLeaf.evidenceRefs, ['tool-result://user-confirmed']);
}));

test('自动开跑闸门：会话重开恢复 / 陈旧 kick / 变更广播都放行不了只剩等用户的计划', withTempHome(async () => {
  const store = createGoalPlanStore();
  const parkId = setupPlan(store, { scan: 'completed', confirm: 'waiting_user' });
  // 模拟停机写入完成后的状态（runner 仍标记 running，但叶子全在等用户）。
  const parked = store.getPlan(parkId);

  assert.equal(shouldRecoverAcceptedGoalRunnerOnConversationOpen(parked), false, '重开会话不应自动续跑');
  assert.equal(isStalledAcceptedGoalRunner(parked), false, '不应被当成卡住而 kick');
  assert.equal(
    shouldAutoStartAcceptedGoalRunnerFromChange({ changeKind: 'goal-accepted' }, parked),
    false,
    '变更广播不应把泵点着',
  );

  // 对照组：还有 running 叶子时，这些闸门必须照常放行（不能把正常恢复一起挡死）。
  const liveId = setupPlan(store, { scan: 'running' });
  const live = store.getPlan(liveId);
  assert.equal(shouldRecoverAcceptedGoalRunnerOnConversationOpen(live), true);
  assert.equal(isStalledAcceptedGoalRunner(live), true);
  assert.equal(
    shouldAutoStartAcceptedGoalRunnerFromChange({ changeKind: 'goal-accepted' }, live),
    true,
  );
}));

test('叶子判定纯函数：终态不阻塞、非终态非等待即继续、空计划不算等待', () => {
  const cases = [
    ['终态 + 等用户 -> 停机', [{ status: 'completed' }, { status: 'waiting_user' }], true],
    ['还有 running 叶子 -> 继续', [{ status: 'waiting_user' }, { status: 'running' }], false],
    ['还有 pending 叶子 -> 继续', [{ status: 'waiting_user' }, { status: 'pending' }], false],
    ['只有等用户 -> 停机', [{ status: 'waiting_user' }], true],
    ['全部终态 + 无等待 -> 不判等待', [{ status: 'completed' }, { status: 'failed' }], false],
    ['只有 cancelled -> 不判等待', [{ status: 'cancelled' }], false],
    ['空计划 -> 不判等待', [], false],
    ['无 tasks -> 不判等待', undefined, false],
    ['父节点状态不参与，只看叶子', [{ status: 'running', subtasks: [{ status: 'waiting_user' }] }], true],
    ['深层嵌套里的 running 叶子 -> 继续', [
      { status: 'completed', subtasks: [{ status: 'waiting_user' }, { status: 'running' }] },
    ], false],
  ];

  for (const [name, tasks, expected] of cases) {
    assert.equal(goalPlanWaitsOnUser(tasks ? { tasks } : {}), expected, name);
  }
});
