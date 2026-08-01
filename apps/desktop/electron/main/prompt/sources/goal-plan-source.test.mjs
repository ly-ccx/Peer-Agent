import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createGoalPlanPromptSource } from '@peer-agent/system-context';

function fakeStore(plansByConversation = {}) {
  return {
    listPlanDetailsByConversation(conversationId) {
      return plansByConversation[conversationId] ?? [];
    },
  };
}

const ACTIVE_PLAN = {
  planId: 'plan-1',
  title: '重构 ChatSurface',
  status: 'executing',
  progress: { completed: 3, total: 7 },
  tasks: [
    { taskId: 'task-1', title: '抽 useElapsedTimer', status: 'completed' },
    { taskId: 'task-2', title: '抽 useAutoScroll', status: 'pending' },
  ],
};

describe('goal-plan prompt source', () => {
  it('renders authoritative taskIds in goal mode when an active plan exists', () => {
    const source = createGoalPlanPromptSource();
    const observation = source.observe({
      mode: 'goal',
      conversationId: 'conv-1',
      goalPlanStore: fakeStore({ 'conv-1': [ACTIVE_PLAN] }),
    });
    const sections = source.render(observation);

    assert.equal(sections.length, 1);
    const section = sections[0];
    assert.equal(section.layer, 'L7_CONTINUITY');
    assert.equal(section.trust, 'runtime');
    assert.match(section.content, /task-1/);
    assert.match(section.content, /task-2/);
    assert.match(section.content, /3\/7/);
    // 必须显式标注为事实快照，而非系统指令。
    assert.match(section.content, /factual/i);
    assert.equal(section.source.kind, 'goal-plan-snapshot');
    assert.equal(section.source.planCount, 1);
  });

  it('renders the active Agent plan in legacy chat wire mode', () => {
    const source = createGoalPlanPromptSource();
    const observation = source.observe({
      mode: 'chat',
      conversationId: 'conv-1',
      goalPlanStore: fakeStore({ 'conv-1': [ACTIVE_PLAN] }),
    });
    const sections = source.render(observation);

    assert.equal(sections.length, 1);
    assert.match(sections[0].content, /task-1/);
    assert.match(sections[0].content, /task-2/);
  });

  it('renders nothing when there is no active plan', () => {
    const source = createGoalPlanPromptSource();
    const observation = source.observe({
      mode: 'goal',
      conversationId: 'conv-x',
      goalPlanStore: fakeStore({}),
    });
    assert.deepEqual(source.render(observation), []);
  });

  it('skips terminal (completed/cancelled) plans', () => {
    const source = createGoalPlanPromptSource();
    const observation = source.observe({
      mode: 'goal',
      conversationId: 'conv-2',
      goalPlanStore: fakeStore({
        'conv-2': [{ ...ACTIVE_PLAN, status: 'completed' }],
      }),
    });
    assert.deepEqual(source.render(observation), []);
  });

  it('is resilient when the store throws', () => {
    const source = createGoalPlanPromptSource();
    const observation = source.observe({
      mode: 'goal',
      conversationId: 'conv-1',
      goalPlanStore: {
        listPlanDetailsByConversation() {
          throw new Error('store unavailable');
        },
      },
    });
    assert.deepEqual(source.render(observation), []);
  });
});
