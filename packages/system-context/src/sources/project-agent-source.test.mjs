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
  assert.match(section.content, /Use coordinate_work with the actual sessionId and expectedRevision/);
  assert.match(section.content, /No second cancel confirmation/);
  assert.match(section.content, /no progress event arrived for 10 minutes/);
  assert.match(section.content, /not waiting on an approval or a question/);
  assert.match(section.content, /GoalPlan interruption reason and the last error/);
  assert.match(section.content, /stop automatic retries and ask the user/);
  assert.match(section.content, /Do not start another attempt/);
  assert.match(section.content, /statusClaims/);
  assert.match(section.content, /Only persisted resultAcceptance/);
  assert.match(section.content, /Never repeat a rejected reply as final free text/);
  assert.match(section.content, /brief public assistant text before tools/);
  assert.match(section.content, /Simple answers can go straight to post_reply/);
  assert.match(section.content, /Progress text does not deliver a result/);
  assert.match(section.content, /On wake turns, remain quiet unless post_reply is needed/);
  assert.match(section.content, /short, self-contained messages/);
  assert.match(section.content, /structured details the interface can reveal on request/);
  assert.match(section.content, /never hide a required user action or uncertainty in details/);
  assert.match(section.content, /explicitly asks for code or technical explanation/);
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

test('主 Bot 的表达规则覆盖委托、结果和受阻，不让内部状态成为对话正文', () => {
  const assembled = assembleSystemContext({ role: 'project_agent', mode: 'project_agent' });
  const content = assembled.sections.find(section => section.id === 'project-agent').content;
  assert.match(content, /Own the work in the first person/);
  assert.match(content, /Lightweight read-only questions do not need a work session/);
  assert.match(content, /one short opening acknowledgment/);
  assert.match(content, /speak only when there is a useful new finding/);
  assert.match(content, /let its later result event bring you back/);
  assert.match(content, /reuse that acknowledgment as post_reply text so it is displayed once/);
  assert.match(content, /queued or blocked start must be explained truthfully/);
  assert.match(content, /result reply should lead with what you learned or accomplished/);
  assert.match(content, /the reason you actually know/);
  assert.match(content, /Ask a specific question only if a user decision is truly needed/);
  assert.match(content, /not fixed scripts or facts to reuse/);
  assert.match(content, /我先看看项目的整体情况/);
  assert.match(content, /host-validated post_reply with sources and current statusClaims/);
  assert.match(content, /never hide a required user action or uncertainty in details/);
});

test('后台启动保持安静，完成事件仍要求核验和真实来源', () => {
  const assembled = assembleSystemContext({ role: 'project_agent', mode: 'project_agent',
    events: [{ kind: 'session_started', sessionId: 'sess-private', summary: 'worker label' }] });
  const rules = assembled.sections.find(section => section.id === 'project-agent');
  assert.match(rules.content, /session_started or routine progress event is not a request for another status report/);
  assert.match(rules.content, /finish quietly without querying tools/);
  assert.match(rules.content, /focus on its sessionId and the current request/);
  assert.match(rules.content, /result_ready event is a task result to review/);
  assert.match(rules.content, /use verify_session when independent verification is missing/);
  assert.match(rules.content, /running-task acknowledgment does not deliver its later result/);
  assert.doesNotMatch(rules.content, /sess-private|worker label/);
  const facts = assembled.sections.filter(section => section.content.includes('sess-private'));
  assert.ok(facts.length > 0);
  assert.ok(facts.every(section => section.layer === 'L7_CONTINUITY'));
});
