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

  it('skips cancelled plans and does not treat them as a follow-up parent', () => {
    const source = createGoalPlanPromptSource();
    const observation = source.observe({
      mode: 'goal',
      conversationId: 'conv-2',
      goalPlanStore: fakeStore({
        'conv-2': [{ ...ACTIVE_PLAN, status: 'cancelled' }],
      }),
    });
    assert.deepEqual(source.render(observation), []);
  });

  it('injects the most recent completed plan so a follow-up can pass parentPlanId', () => {
    const source = createGoalPlanPromptSource();
    const observation = source.observe({
      mode: 'chat',
      conversationId: 'conv-follow',
      goalPlanStore: fakeStore({
        'conv-follow': [
          {
            planId: 'plan-old',
            title: '统一工具栏圆角',
            status: 'completed',
            completedAt: '2026-08-13T10:00:00.000Z',
            updatedAt: '2026-08-13T10:00:00.000Z',
          },
          {
            planId: 'plan-new',
            title: '截图验收工具栏圆角',
            status: 'completed',
            completedAt: '2026-08-14T08:00:00.000Z',
            updatedAt: '2026-08-14T08:00:00.000Z',
            tasks: [{ taskId: 'task-r2', title: '改圆角', status: 'completed' }],
          },
        ],
      }),
    });
    const sections = source.render(observation);
    assert.equal(sections.length, 1);
    assert.equal(observation.recentCompleted.planId, 'plan-new');
    assert.match(sections[0].content, /parentPlanId/);
    assert.match(sections[0].content, /plan-new/);
    assert.match(sections[0].content, /截图验收工具栏圆角/);
    assert.match(sections[0].content, /sourceTaskId=task-r2/);
    assert.doesNotMatch(sections[0].content, /plan-old/);
    assert.equal(sections[0].source.recentCompleted.planId, 'plan-new');
    assert.equal(sections[0].source.recentCompleted.sourceTaskId, 'task-r2');
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
