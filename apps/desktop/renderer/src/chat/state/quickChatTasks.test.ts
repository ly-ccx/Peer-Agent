import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeQuickChatTasks, projectQuickChatPlanTasks, projectQuickChatTasks, type QuickChatTaskConversation } from './quickChatTasks.ts';
import type { GoalPlan } from '@peer-agent/protocol';

function conversation(messages: QuickChatTaskConversation['messages']): QuickChatTaskConversation {
  return { id: 'conversation-1', title: '发布应用', workspacePath: '/repo', messages };
}

const requestSegment = {
  type: 'tool-call' as const,
  tool: 'local.interaction.request_user_input',
  args: { question: '发布到哪个环境？', options: ['日常', '预发'] },
  result: JSON.stringify({ question: '发布到哪个环境？', options: ['日常', '预发'] }),
};

describe('projectQuickChatTasks', () => {
  it('projects the latest unresolved request_user_input', () => {
    const tasks = projectQuickChatTasks([conversation([
      { id: 'a1', role: 'assistant', content: '', timestamp: 10, segments: [requestSegment] },
    ])]);

    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].conversationTitle, '发布应用');
    assert.equal(tasks[0].view.question, '发布到哪个环境？');
    assert.deepEqual(tasks[0].view.options, ['日常', '预发']);
  });

  it('does not project a request followed by a user reply', () => {
    const tasks = projectQuickChatTasks([conversation([
      { id: 'a1', role: 'assistant', content: '', segments: [requestSegment] },
      { id: 'u1', role: 'user', content: '日常' },
    ])]);

    assert.deepEqual(tasks, []);
  });

  it('sorts tasks by newest request first', () => {
    const older = conversation([{ id: 'a1', role: 'assistant', content: '', timestamp: 10, segments: [requestSegment] }]);
    const newer = { ...conversation([{ id: 'a2', role: 'assistant', content: '', timestamp: 20, segments: [requestSegment] }]), id: 'conversation-2' };

    assert.deepEqual(projectQuickChatTasks([older, newer]).map((task) => task.conversationId), [
      'conversation-2',
      'conversation-1',
    ]);
  });
});

describe('projectQuickChatPlanTasks', () => {
  const plan = {
    planId: 'plan-1', conversationId: 'conversation-1', title: '发布方案', goal: '完成发布',
    status: 'awaiting_approval', createdAt: '2026-07-13T10:00:00.000Z', tasks: [], progress: { total: 0, completed: 0, failed: 0, blocked: 0, percent: 0 },
  } as unknown as GoalPlan;

  it('projects only awaiting approval plans and maps conversation metadata', () => {
    const tasks = projectQuickChatPlanTasks([plan, { ...plan, planId: 'done', status: 'completed' }], [conversation([])]);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].kind, 'plan-approval');
    assert.equal(tasks[0].conversationTitle, '发布应用');
  });

  it('orders plan approvals before interaction requests', () => {
    const plans = projectQuickChatPlanTasks([plan], [conversation([])]);
    const interactions = projectQuickChatTasks([conversation([{ id: 'a1', role: 'assistant', content: '', segments: [requestSegment] }])]);
    assert.deepEqual(mergeQuickChatTasks(plans, interactions).map((task) => task.kind), ['plan-approval', 'interaction']);
  });
});
