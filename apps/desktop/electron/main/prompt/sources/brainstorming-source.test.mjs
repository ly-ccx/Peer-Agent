import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createBrainstormingPromptSource } from './brainstorming-source.mjs';

// resolveGoalPlanGate 读取 goalPlanStore.listPlansByConversation(conversationId)，
// 可执行状态为 approved / executing / completed。
function fakeStore(plansByConversation = {}) {
  return {
    listPlansByConversation(conversationId) {
      return plansByConversation[conversationId] ?? [];
    },
  };
}

function renderWith(input) {
  const source = createBrainstormingPromptSource();
  const observation = source.observe(input);
  return source.render(observation, input);
}

describe('brainstorming prompt source phase awareness', () => {
  it('注入设计协作规范：非 goal 模式', () => {
    const sections = renderWith({ mode: 'chat' });
    assert.equal(sections.length, 1);
    assert.equal(sections[0].id, 'agent.brainstorming');
  });

  it('注入设计协作规范：goal 模式但计划尚未获批（草拟阶段）', () => {
    const sections = renderWith({
      mode: 'goal',
      conversationId: 'conv-1',
      goalPlanStore: fakeStore({ 'conv-1': [{ status: 'draft' }] }),
    });
    assert.equal(sections.length, 1);
    assert.equal(sections[0].id, 'agent.brainstorming');
  });

  it('注入设计协作规范：goal 模式且无任何计划', () => {
    const sections = renderWith({
      mode: 'goal',
      conversationId: 'conv-1',
      goalPlanStore: fakeStore({}),
    });
    assert.equal(sections.length, 1);
  });

  it('撤掉设计协作规范：goal 模式且计划已获批（进入连续执行）', () => {
    const sections = renderWith({
      mode: 'goal',
      conversationId: 'conv-1',
      goalPlanStore: fakeStore({ 'conv-1': [{ status: 'approved' }] }),
    });
    assert.deepEqual(sections, []);
  });

  it('撤掉设计协作规范：goal 模式且计划执行中', () => {
    const sections = renderWith({
      mode: 'goal',
      conversationId: 'conv-1',
      goalPlanStore: fakeStore({ 'conv-1': [{ status: 'executing' }] }),
    });
    assert.deepEqual(sections, []);
  });
});
