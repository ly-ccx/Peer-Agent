import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGoalRunnerPromptSource } from './goal-runner-source.mjs';

function makeStore(plan) {
  return {
    getActivePlanByConversation() {
      return plan;
    },
  };
}

const samplePlan = {
  planId: 'plan-1',
  title: 'Ship goal runner',
  goal: 'Make the runner advance autonomously',
  status: 'executing',
  boundaries: { inScope: ['runner loop'], outOfScope: ['unrelated refactors'] },
  successCriteria: ['tests pass', 'no boundary cross'],
  tasks: [
    { taskId: 't1', title: 'design', status: 'completed', evidenceRefs: ['e1'] },
    { taskId: 't2', title: 'implement', status: 'in_progress', evidenceRefs: [] },
  ],
  runner: {
    currentTaskId: 't2',
    turnCount: 3,
    maxTurns: 20,
    toolCallCount: 7,
    maxToolCalls: 80,
    explorerCount: 1,
    maxExplorers: 4,
  },
};

test('chat mode renders nothing', () => {
  const source = createGoalRunnerPromptSource();
  const observation = source.observe({ mode: 'chat', goalPlanStore: makeStore(samplePlan) });
  assert.deepEqual(source.render(observation), []);
});

test('goal mode without active plan renders nothing', () => {
  const source = createGoalRunnerPromptSource();
  const observation = source.observe({ mode: 'goal', goalPlanStore: makeStore(null) });
  assert.deepEqual(source.render(observation), []);
});

test('goal mode renders facts + contract sections', () => {
  const source = createGoalRunnerPromptSource();
  const observation = source.observe({
    mode: 'goal',
    conversationId: 'c1',
    goalPlanStore: makeStore(samplePlan),
  });
  const sections = source.render(observation);
  assert.equal(sections.length, 2);

  const facts = sections.find((s) => s.id === 'runtime.goal-runner.facts');
  const contract = sections.find((s) => s.id === 'runtime.goal-runner.contract');
  assert.ok(facts, 'facts section present');
  assert.ok(contract, 'contract section present');

  assert.equal(facts.layer, 'L7_CONTINUITY');
  assert.equal(facts.trust, 'runtime');
  assert.match(facts.content, /plan-1/);
  assert.match(facts.content, /current task: t2/);
  assert.match(facts.content, /turns 3\/20/);
  assert.match(facts.content, /explorers 1\/4/);
  assert.match(facts.content, /in scope:/);
  assert.match(facts.content, /out of scope:/);
  assert.match(facts.content, /success criteria:/);

  assert.equal(contract.layer, 'L6_MODE_REMINDER');
  assert.match(contract.content, /do not re-plan/);
  assert.match(contract.content, /goal_update_task/);
});

test('completed plan status is not injected', () => {
  const source = createGoalRunnerPromptSource();
  const observation = source.observe({
    mode: 'goal',
    goalPlanStore: makeStore({ ...samplePlan, status: 'completed' }),
  });
  assert.deepEqual(source.render(observation), []);
});

test('store errors degrade to no sections', () => {
  const source = createGoalRunnerPromptSource();
  const observation = source.observe({
    mode: 'goal',
    goalPlanStore: {
      getActivePlanByConversation() {
        throw new Error('boom');
      },
    },
  });
  assert.deepEqual(source.render(observation), []);
});
