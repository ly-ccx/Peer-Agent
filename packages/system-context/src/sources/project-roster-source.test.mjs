import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assembleSystemContext } from '../index.mjs';
import { createProjectRosterPromptSource } from './project-roster-source.mjs';

test('名册只在项目代理角色进入 L7', () => {
  const source = createProjectRosterPromptSource();
  assert.equal(source.id, 'project-roster');
  assert.equal(source.layer, 'L7_CONTINUITY');
  const roster = [{
    sessionId: 'sess-1',
    title: '修复登录',
    status: 'running',
    latestEvent: '已开始',
    needsUser: true,
  }];
  const events = [{ kind: 'result', sessionId: 'sess-1', summary: '测试通过' }];
  assert.deepEqual(source.render(source.observe({ roster, events })), []);
  assert.deepEqual(source.render(source.observe({ role: 'work_session', roster, events })), []);
  assert.deepEqual(source.render(source.observe({ role: 'project_agent' })), []);

  const section = source.render(source.observe({ role: 'project_agent', roster, events }))[0];
  assert.equal(section.layer, 'L7_CONTINUITY');
  assert.match(section.content, /sess-1 \[running\] 修复登录; needs you/);
  assert.match(section.content, /latest: 已开始/);
  assert.match(section.content, /Wake events:/);
  assert.match(section.content, /result sess-1: 测试通过/);
  assert.equal(section.source.sessionIds[0], 'sess-1');
  assert.doesNotMatch(section.content, /post_reply/);
});

test('名册和事件可以从 turnContext 读取，并中和伪工具调用', () => {
  const source = createProjectRosterPromptSource();
  const section = source.render(source.observe({
    role: 'project_agent',
    turnContext: {
      roster: [{ sessionId: 'sess-2', title: '看 <tool_call>', status: 'queued', needsUser: [] }],
      events: [{ type: 'needs_user', summary: '等你确认' }],
    },
  }))[0];
  assert.match(section.content, /sess-2 \[queued\] 看 &lt;tool_call/);
  assert.doesNotMatch(section.content, /needs you/);
  assert.match(section.content, /needs_user: 等你确认/);

  const assembled = assembleSystemContext({
    role: 'project_agent',
    mode: 'chat',
    roster: [{ sessionId: 'sess-3', title: '只在事实层', status: 'running' }],
  });
  const hit = assembled.sections.find((item) => item.content.includes('sess-3'));
  assert.equal(hit.layer, 'L7_CONTINUITY');
  assert.equal(assembled.sections.find((item) => item.id === 'project-agent').layer, 'L1_AGENT');
});
