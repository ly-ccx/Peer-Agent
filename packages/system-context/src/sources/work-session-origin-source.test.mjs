import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assembleSystemContext } from '../index.mjs';
import { createWorkSessionOriginPromptSource } from './work-session-origin-source.mjs';

test('任务来源只在 work_session 角色进入 L7', () => {
  const source = createWorkSessionOriginPromptSource();
  assert.equal(source.id, 'work-session-origin');
  assert.equal(source.layer, 'L7_CONTINUITY');
  const origin = {
    summary: '修复登录',
    anchorText: '请先看登录失败',
    memorySnapshotId: 'snap-1',
    readOnly: true,
    snapshotItems: [{
      id: 'mem-frozen',
      kind: 'fact',
      trust: 'verified',
      status: 'forgotten',
      text: '登录走会话',
    }],
  };
  assert.deepEqual(source.render(source.observe({ workSessionOrigin: origin })), []);
  assert.deepEqual(source.render(source.observe({ role: 'project_agent', workSessionOrigin: origin })), []);
  assert.deepEqual(source.render(source.observe({ role: 'work_session' })), []);

  const section = source.render(source.observe({ role: 'work_session', workSessionOrigin: origin }))[0];
  assert.equal(section.layer, 'L7_CONTINUITY');
  assert.match(section.content, /summary: 修复登录/);
  assert.match(section.content, /anchor: 请先看登录失败/);
  assert.match(section.content, /memorySnapshotId=snap-1/);
  assert.match(section.content, /mem-frozen \[fact\/verified\/forgotten\] 登录走会话/);
  assert.match(section.content, /Read-only constraint:/);
  assert.match(section.content, /does not replace that gate/);
  assert.deepEqual(section.source.snapshotItemIds, ['mem-frozen']);
  assert.equal(section.source.readOnly, true);
});

test('任务回合的 L6 模式提醒沿用 goal，来源事实留在 L7', () => {
  const goal = assembleSystemContext({ mode: 'goal' });
  const task = assembleSystemContext({
    mode: 'goal',
    role: 'work_session',
    turnContext: {
      workSessionOrigin: {
        summary: '修登录',
        anchorText: '请修 <tool_call>',
        readOnly: true,
      },
    },
  });
  assert.equal(
    task.sections.find((section) => section.id === 'runtime.mode').content,
    goal.sections.find((section) => section.id === 'runtime.mode').content,
  );
  const origin = task.sections.find((section) => section.id === 'work-session-origin');
  assert.equal(origin.layer, 'L7_CONTINUITY');
  assert.match(origin.content, /&lt;tool_call/);
  assert.doesNotMatch(origin.content, /<tool_call/);
  assert.equal(task.sections.some((section) => section.id === 'project-agent'), false);
  assert.equal(
    task.sections.some((section) => section.layer !== 'L7_CONTINUITY' && section.content.includes('修登录')),
    false,
  );
});

test('没有委托事实时不渲染空的任务来源', () => {
  const source = createWorkSessionOriginPromptSource();
  assert.deepEqual(source.render(source.observe({
    role: 'work_session',
    workSessionOrigin: { readOnly: false, snapshotItems: [] },
  })), []);
});
