import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyGoalMessageRoute,
  classifyGoalMessage,
  consumesRequestedUserInput,
  routeGoalMessage,
} from './goal-message-router.mjs';

const activeGoalPlan = Object.freeze({
  planId: 'goal-1',
  status: 'executing',
  workflowKind: 'goal_self_driven',
});

test('routeGoalMessage starts intake (not a Goal) when no active Goal exists', () => {
  const route = routeGoalMessage({
    messageText: '把右侧目标面板拆成 Goal Plan Run',
    activeGoalPlan: null,
  });

  // 方案乙：隐式新目标先进 intake 判别，而不是无条件建 accepted 目标。
  assert.equal(route.type, 'start_intake');
  assert.equal(route.intent, 'new_goal_implicit');
  assert.equal(route.objective, '把右侧目标面板拆成 Goal Plan Run');
});

test('discussion and evaluation prompts enter intake instead of becoming accepted GoalPlans', () => {
  for (const messageText of [
    '这是一个讨论问题，那我怎么在界面上看到 Task-Plan 的格式？',
    '你觉得当前模式合理吗？',
    '那界面怎么设计好？',
  ]) {
    const route = routeGoalMessage({ messageText, activeGoalPlan: null });
    assert.equal(route.type, 'start_intake');
    assert.equal(route.intent, 'new_goal_implicit');
  }
});

test('routeGoalMessage routes 继续 to the current Goal instead of creating a new Goal', () => {
  const route = routeGoalMessage({
    messageText: '继续',
    activeGoalPlan,
  });

  assert.equal(route.type, 'append_goal_event');
  assert.equal(route.goalPlanId, 'goal-1');
  assert.equal(route.intent, 'resume');
  assert.equal(route.eventType, 'goal_resumed');
});

test('applyGoalMessageRoute restores a failed Goal before recording the user resume event', () => {
  const failedPlan = {
    ...activeGoalPlan,
    status: 'failed',
    runner: { status: 'failed', phase: 'act', lastError: 'stream interrupted' },
  };
  const route = routeGoalMessage({ messageText: '继续', activeGoalPlan: failedPlan });
  const calls = [];
  const goalPlanStore = {
    resumeRunner(planId, patch) {
      calls.push(['resume', planId, patch]);
    },
    appendRunEvent(planId, event) {
      calls.push(['event', planId, event]);
      return event;
    },
  };

  applyGoalMessageRoute({ route, activeGoalPlan: failedPlan, goalPlanStore });

  assert.deepEqual(calls.map(([kind]) => kind), ['resume', 'event']);
  assert.deepEqual(calls[0], ['resume', 'goal-1', { intent: 'execute', phase: 'act' }]);
  assert.equal(calls[1][2].type, 'goal_resumed');
  assert.equal(calls[1][2].payload.source, 'chat:send');
});

test('applyGoalMessageRoute atomically consumes a reply to requested_user_input', () => {
  const blockedPlan = {
    ...activeGoalPlan,
    runner: { status: 'waiting_user', phase: 'waiting_user', blockedReason: 'requested_user_input' },
  };
  const route = routeGoalMessage({ messageText: '继续修复全部测试失败', activeGoalPlan: blockedPlan });
  const calls = [];
  const goalPlanStore = {
    consumeRequestedUserInput(planId, event) {
      calls.push(['consume', planId, event]);
      return { ...blockedPlan, runner: { status: 'running', phase: 'orient' } };
    },
    appendRunEvent() {
      calls.push(['event']);
    },
  };

  assert.equal(consumesRequestedUserInput({ route, activeGoalPlan: blockedPlan }), true);
  const result = applyGoalMessageRoute({ route, activeGoalPlan: blockedPlan, goalPlanStore });

  assert.deepEqual(calls.map(([kind]) => kind), ['consume']);
  assert.equal(calls[0][2].payload.messageText, '继续修复全部测试失败');
  assert.equal(result.runner.status, 'running');
});

test('applyGoalMessageRoute keeps unrelated Runner blockers intact', () => {
  const blockedPlan = {
    ...activeGoalPlan,
    runner: { status: 'blocked', phase: 'blocked', blockedReason: 'permission_required' },
  };
  const route = routeGoalMessage({ messageText: '继续', activeGoalPlan: blockedPlan });
  const calls = [];
  const goalPlanStore = {
    consumeRequestedUserInput() {
      calls.push(['consume']);
    },
    appendRunEvent(planId, event) {
      calls.push(['event', planId, event]);
      return event;
    },
  };

  assert.equal(consumesRequestedUserInput({ route, activeGoalPlan: blockedPlan }), false);
  applyGoalMessageRoute({ route, activeGoalPlan: blockedPlan, goalPlanStore });
  assert.deepEqual(calls.map(([kind]) => kind), ['event']);
});

test('applyGoalMessageRoute does not treat pause as a requested_user_input answer', () => {
  const blockedPlan = {
    ...activeGoalPlan,
    runner: { status: 'blocked', phase: 'blocked', blockedReason: 'requested_user_input' },
  };
  const route = routeGoalMessage({ messageText: '暂停', activeGoalPlan: blockedPlan });
  assert.equal(route.intent, 'pause');
  assert.equal(consumesRequestedUserInput({ route, activeGoalPlan: blockedPlan }), false);
});

test('applyGoalMessageRoute does not reset a non-failed Goal', () => {
  const route = routeGoalMessage({ messageText: '继续', activeGoalPlan });
  let resumeCount = 0;
  applyGoalMessageRoute({
    route,
    activeGoalPlan,
    goalPlanStore: {
      resumeRunner() { resumeCount += 1; },
      appendRunEvent() {},
    },
  });
  assert.equal(resumeCount, 0);
});

test('applyGoalMessageRoute lets a foreground continuation take over a recoverable system blocker', () => {
  const blockedPlan = {
    ...activeGoalPlan,
    runner: {
      status: 'blocked',
      phase: 'blocked',
      blockedReason: 'No renderer window is available for Goal Runner',
    },
  };
  const route = routeGoalMessage({ messageText: '继续推进刚才的改动', activeGoalPlan: blockedPlan });
  const calls = [];
  applyGoalMessageRoute({
    route,
    activeGoalPlan: blockedPlan,
    goalPlanStore: {
      resumeRunner(planId, patch) {
        calls.push(['resume', planId, patch]);
      },
      appendRunEvent(planId, event) {
        calls.push(['event', planId, event]);
      },
    },
  });

  assert.deepEqual(calls.map(([kind]) => kind), ['resume', 'event']);
  assert.equal(calls[0][1], 'goal-1');
  assert.equal(calls[0][2].intent, 'execute');
  assert.equal(calls[0][2].phase, 'orient');
});

test('applyGoalMessageRoute preserves user-owned and unknown blockers', () => {
  for (const blockedReason of ['permission_required', 'product decision required']) {
    const blockedPlan = {
      ...activeGoalPlan,
      runner: { status: 'blocked', phase: 'blocked', blockedReason },
    };
    const route = routeGoalMessage({ messageText: '补充一些背景', activeGoalPlan: blockedPlan });
    let resumeCount = 0;
    applyGoalMessageRoute({
      route,
      activeGoalPlan: blockedPlan,
      goalPlanStore: {
        resumeRunner() { resumeCount += 1; },
        appendRunEvent() {},
      },
    });
    assert.equal(resumeCount, 0, blockedReason);
  }
});

test('routeGoalMessage routes requirement overrides to the current Goal', () => {
  const route = routeGoalMessage({
    messageText: '全部改成 209',
    activeGoalPlan,
  });

  assert.equal(route.type, 'append_goal_event');
  assert.equal(route.intent, 'requirement_override');
  assert.equal(route.eventType, 'requirement_override');
});

test('routeGoalMessage starts intake even when the user explicitly asks for a new Goal', () => {
  const route = routeGoalMessage({
    messageText: '新开一个目标：整理发布流程',
    activeGoalPlan,
  });

  // 方案乙：显式「新建目标」也先进 intake 收敛出具体目标后再执行，
  // 避免把一句宽泛的「新建目标做个 X」直接当成成型契约。
  assert.equal(route.type, 'start_intake');
  assert.equal(route.intent, 'new_goal_explicit');
});

test('classifyGoalMessage treats correction wording as user_correction', () => {
  const classification = classifyGoalMessage('不是这个意思，你走偏了');

  assert.equal(classification.intent, 'correction');
  assert.equal(classification.eventType, 'user_correction');
});


test('applyGoalMessageRoute restores a failed Goal on follow_up (not only resume keyword)', () => {
  const failedPlan = {
    planId: 'goal-1',
    status: 'failed',
    workflowKind: 'goal_self_driven',
    runner: { phase: 'act' },
  };
  const calls = [];
  const goalPlanStore = {
    resumeRunner(planId, patch) {
      calls.push(['resume', planId, patch]);
      return { ...failedPlan, status: 'executing' };
    },
    appendRunEvent(planId, event) {
      calls.push(['event', planId, event]);
      return event;
    },
  };
  const route = {
    type: 'append_goal_event',
    goalPlanId: 'goal-1',
    intent: 'follow_up',
    eventType: 'message_routed',
    summaryCode: 'msg_follow_up',
    summary: '用户补充了一句，已归入当前目标：继续推进',
    messageText: '继续推进刚才的改动',
  };
  applyGoalMessageRoute({ route, activeGoalPlan: failedPlan, goalPlanStore });
  assert.deepEqual(calls.map(([kind]) => kind), ['resume', 'event']);
  assert.equal(calls[0][0], 'resume');
  assert.equal(calls[0][1], 'goal-1');
});

