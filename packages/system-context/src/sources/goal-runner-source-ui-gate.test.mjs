import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGoalRunnerPromptSource } from './goal-runner-source.mjs';

function fakeStore({ plan, required }) {
  return {
    getActivePlanByConversation() {
      return plan;
    },
    ...(required === undefined ? {} : {
      isUiDeliveryRequired() {
        return required === true; // store 契约：返回布尔值
      },
    }),
  };
}

const basePlan = {
  planId: 'plan-ui-1',
  title: '调整导航栏',
  goal: '没有内容时隐藏这一栏',
  status: 'executing',
  activationKind: 'accepted_goal',
  successCriteria: [],
  tasks: [],
};

function factsText(blocks) {
  const facts = blocks.find((block) => block?.id === 'runtime.goal-runner.facts');
  return facts?.content ?? '';
}

test('visual-gate-source/武装时渲染ARMED事实行', () => {
  const source = createGoalRunnerPromptSource();
  const observation = source.observe({
    mode: 'goal',
    conversationId: 'conv-1',
    goalPlanStore: fakeStore({ plan: basePlan, required: true }),
  });
  assert.equal(observation.visualGateArmed, true);
  const text = factsText(source.render(observation));
  assert.match(text, /visual verification gate: ARMED/);
});

test('visual-gate-source/未武装时不渲染ARMED行', () => {
  const source = createGoalRunnerPromptSource();
  const observation = source.observe({
    mode: 'goal',
    conversationId: 'conv-1',
    goalPlanStore: fakeStore({ plan: basePlan, required: false }),
  });
  assert.equal(observation.visualGateArmed, false);
  const text = factsText(source.render(observation));
  assert.doesNotMatch(text, /visual verification gate: ARMED/);
});

test('visual-gate-source/旧宿主store无isUiDeliveryRequired时零变化', () => {
  const source = createGoalRunnerPromptSource();
  const observation = source.observe({
    mode: 'goal',
    conversationId: 'conv-1',
    goalPlanStore: fakeStore({ plan: basePlan }),
  });
  assert.equal(observation.visualGateArmed, false);
  const text = factsText(source.render(observation));
  assert.doesNotMatch(text, /visual verification gate: ARMED/);
});

test('visual-gate-source/isUiDeliveryRequired抛错时降级为未武装', () => {
  const source = createGoalRunnerPromptSource();
  const observation = source.observe({
    mode: 'goal',
    conversationId: 'conv-1',
    goalPlanStore: {
      getActivePlanByConversation() {
        return basePlan;
      },
      isUiDeliveryRequired() {
        throw new Error('authority read failed');
      },
    },
  });
  assert.equal(observation.visualGateArmed, false);
});
