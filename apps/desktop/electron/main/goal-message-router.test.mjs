import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyGoalMessageRoute, classifyGoalMessage, routeGoalMessage } from './goal-message-router.mjs';

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

