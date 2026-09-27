import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assembleSystemContext } from '../index.mjs';
import { createProjectAgentPromptSource } from './project-agent-source.mjs';

test('项目代理规则只在 project_agent 角色进入 L1', () => {
  const source = createProjectAgentPromptSource();
  assert.equal(source.id, 'project-agent');
  assert.equal(source.layer, 'L1_AGENT');
  assert.deepEqual(source.render(source.observe({})), []);
  assert.deepEqual(source.render(source.observe({ mode: 'project_agent' })), []);
  assert.deepEqual(source.render(source.observe({ role: 'work_session' })), []);
  assert.deepEqual(source.render(source.observe({ role: 'goal_runner', mode: 'goal' })), []);

  const section = source.render(source.observe({ role: 'project_agent' }))[0];
  assert.equal(section.layer, 'L1_AGENT');
  assert.match(section.content, /post_reply/);
  assert.match(section.content, /Hand code changes and other workspace writes to a work session/);
  assert.match(section.content, /Do not restate raw tool output/);
  assert.doesNotMatch(section.content, /mem-/);
});

test('代理事实不进入 L1，普通会话不出现代理规则', () => {
  const quiet = assembleSystemContext({ mode: 'chat' });
  assert.equal(quiet.sections.some((section) => section.id === 'project-agent'), false);

  const assembled = assembleSystemContext({
    mode: 'chat',
    role: 'project_agent',
    roster: [{ sessionId: 'sess-login', title: '修复登录', status: 'running', needsUser: true }],
    projectMemory: [{
      id: 'mem-duty',
      kind: 'responsibility',
      text: '负责登录边界',
      trust: 'stated',
      scope: 'project',
      status: 'active',
    }],
  });
  const rules = assembled.sections.find((section) => section.id === 'project-agent');
  assert.equal(rules.layer, 'L1_AGENT');
  assert.doesNotMatch(rules.content, /sess-login|负责登录边界/);
  const factual = assembled.sections.filter((section) => /sess-login|负责登录边界/.test(section.content));
  assert.ok(factual.length > 0);
  assert.ok(factual.every((section) => section.layer === 'L7_CONTINUITY'));
});
