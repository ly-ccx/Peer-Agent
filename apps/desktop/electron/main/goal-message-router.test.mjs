import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyGoalMessage, routeGoalMessage } from './goal-message-router.mjs';

const activeGoalPlan = Object.freeze({
  planId: 'goal-1',
  status: 'executing',
  workflowKind: 'goal_self_driven',
});

test('routeGoalMessage creates a Goal when no active Goal exists', () => {
  const route = routeGoalMessage({
    messageText: '把右侧目标面板拆成 Goal Plan Run',
    activeGoalPlan: null,
  });

  assert.equal(route.type, 'create_goal');
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

test('routeGoalMessage routes requirement overrides to the current Goal', () => {
  const route = routeGoalMessage({
    messageText: '全部改成 209',
    activeGoalPlan,
  });

  assert.equal(route.type, 'append_goal_event');
  assert.equal(route.intent, 'requirement_override');
  assert.equal(route.eventType, 'requirement_override');
});

test('routeGoalMessage only creates a new Goal when the user explicitly asks for one', () => {
  const route = routeGoalMessage({
    messageText: '新开一个目标：整理发布流程',
    activeGoalPlan,
  });

  assert.equal(route.type, 'create_goal');
  assert.equal(route.intent, 'new_goal_explicit');
});

test('classifyGoalMessage treats correction wording as user_correction', () => {
  const classification = classifyGoalMessage('不是这个意思，你走偏了');

  assert.equal(classification.intent, 'correction');
  assert.equal(classification.eventType, 'user_correction');
});
