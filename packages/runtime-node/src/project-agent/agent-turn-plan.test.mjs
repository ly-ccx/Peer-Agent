import assert from 'node:assert/strict';
import test from 'node:test';
import {
  USER_TURN_LIMITS,
  WAKE_TURN_LIMITS,
  finishAgentTurn,
  planAgentTurn,
} from './agent-turn-plan.mjs';

test('persisted objective reply retains its host observation refs alongside later task evidence',()=>{
 const observation='objective-probe:ws:actual';
 const finished=finishAgentTurn({turnId:'watch-turn',plan:planAgentTurn({kind:'wake'}),rounds:[{toolCalls:[
  {name:'get_session',result:{ok:true,evidenceRef:'tool-result://actual-task'}},
  {name:'post_reply',input:{text:'Observation',evidenceRefs:['forged']},result:{ok:true,message:{id:'reply',kind:'agent_reply',content:'Observation',meta:{evidenceRefs:[observation]}}}}
 ]}]});
 assert.deepEqual(finished.messages[1].meta.evidenceRefs,[observation,'tool-result://actual-task']);
});

test('用户回合带上预算和上下文槽，唤醒回合只注入提醒', () => {
  const event = { eventId: 'evt-1', seq: 1, kind: 'session_verified' };
  const user = planAgentTurn({
    kind: 'user',
    userInputs: [{ inputId: 'in1', text: '你好' }],
    events: [event],
    modelProviderId: 'model-pa',
    context: { sources: ['memory-1'] },
  });
  assert.equal(user.kind, 'user');
  assert.equal(user.mode, 'project_agent');
  assert.equal(user.turnProfile.role, 'project_agent');
  assert.equal(user.turnProfile.workspaceId, undefined);
  assert.deepEqual(user.turnProfile.context, { sources: ['memory-1'], events: [event], inputAnchors: [{ messageId: 'input-in1', text: '你好' }] });
  assert.equal(planAgentTurn({ kind: 'user', workspaceId: ' ws-1 ' }).turnProfile.workspaceId, 'ws-1');
  assert.equal(user.modelProviderId, 'model-pa');
  assert.deepEqual(user.limits, { maxRounds: 10, maxToolCalls: 20 });
  assert.equal(user.reminder, null);
  assert.equal(user.userInputs[0].text, '你好');
  user.limits.maxRounds = 1;
  assert.equal(USER_TURN_LIMITS.maxRounds, 10);

  const wake = planAgentTurn({
    kind: 'wake',
    userInputs: [{ inputId: 'should-drop', text: '不该出现' }],
    events: [event],
    roster: { sessions: ['sess-1'] },
    context: null,
  });
  event.eventId = 'changed';
  assert.equal(wake.kind, 'wake');
  assert.equal(wake.userInputs.length, 0);
  assert.equal(wake.events[0].eventId, 'evt-1');
  assert.deepEqual(wake.limits, { maxRounds: 6, maxToolCalls: 12 });
  assert.equal(WAKE_TURN_LIMITS.maxToolCalls, 12);
  assert.equal(wake.reminder.layer, 'L6_MODE_REMINDER');
  assert.equal(wake.reminder.kind, 'project-agent-wake');
  assert.match(wake.reminder.content, /not a new user message/);
  assert.doesNotMatch(wake.reminder.content, /Roster:/);
  assert.deepEqual(wake.turnProfile.context, { events: [{eventId:'evt-1',seq:1,kind:'session_verified'}], roster: {sessions:['sess-1']} });
});

test('没有 post_reply 的用户回合兜底挂到全部输入，唤醒沉默不写回复', () => {
  const user = planAgentTurn({
    kind: 'user',
    userInputs: [{ inputId: 'in1' }, { inputId: 'in2', messageId: 'input-custom' }],
  });
  const fallback = finishAgentTurn({
    turnId: 'turn-1',
    plan: user,
    rounds: [
      { text: '先看', toolCalls: [{ name: 'list_sessions', input: {}, result: { ok: true } }] },
      { text: '一起处理', toolCalls: [] },
    ],
  });
  assert.equal(fallback.replied, true);
  assert.equal(fallback.messages[0].kind, 'agent_turn');
  assert.equal(fallback.messages[0].content, '');
  assert.equal(fallback.messages[0].rounds[0].toolCalls[0].name, 'list_sessions');
  const reply = fallback.messages[1];
  assert.equal(reply.kind, 'agent_reply');
  assert.equal(reply.fallback, true);
  assert.equal(reply.content, '一起处理');
  assert.deepEqual(reply.replyTo, ['input-in1', 'input-custom']);

  const spoken = finishAgentTurn({
    turnId: 'turn-2',
    plan: user,
    rounds: [{
      text: '旁白',
      toolCalls: [{ name: 'post_reply', input: { text: '收到', replyTo: ['input-in1'] }, result: { ok: true } }],
    }],
  });
  assert.equal(spoken.messages.filter((message) => message.kind === 'agent_reply').length, 1);
  assert.equal(spoken.messages[1].fallback, false);
  assert.equal(spoken.messages[1].content, '收到');
  assert.deepEqual(spoken.messages[1].replyTo, ['input-in1']);
  assert.equal(spoken.messages[1].meta, undefined);

  const withEvidence = finishAgentTurn({
    turnId: 'turn-evidence',
    plan: user,
    rounds: [
      {
        text: '',
        toolCalls: [{
          name: 'get_verification_detail',
          input: { sessionId: 's-1', evidenceRefs: ['../secret'] },
          result: {
            ok: true,
            output: {
              ok: true,
              checks: [{ name: 'leaf_evidence', result: 'passed', evidenceRefs: ['tool-result://host-verifier'] }],
              outputs: [{ evidenceRef: 'local-shell-artifact://task/stdout', summary: 'npm test' }],
            },
          },
        }],
      },
      {
        text: '结论',
        toolCalls: [{ name: 'post_reply', input: { text: '通过了', replyTo: ['input-in1'], evidenceRefs: ['forged'] }, result: { ok: true } }],
      },
    ],
  });
  assert.deepEqual(withEvidence.messages[1].meta.evidenceRefs, [
    'tool-result://host-verifier',
    'local-shell-artifact://task/stdout',
  ]);

  const wake = finishAgentTurn({
    turnId: 'turn-3',
    plan: planAgentTurn({ kind: 'wake', events: [{ eventId: 'evt-1' }] }),
    rounds: [{ text: '先不说', toolCalls: [] }],
  });
  assert.equal(wake.replied, false);
  assert.deepEqual(wake.messages.map((message) => message.kind), ['agent_turn']);

  const failed = finishAgentTurn({
    turnId: 'turn-4',
    plan: user,
    rounds: [],
    failed: true,
    reason: '连接中断',
  });
  assert.equal(failed.messages[1].kind, 'system_card');
  assert.equal(failed.messages[1].card, 'agent_unavailable');
  assert.equal(failed.messages[1].content, '代理暂时不可用：连接中断');
  assert.deepEqual(failed.messages[1].actions, ['retry']);
});

test('回复上的记忆 id 来自宿主结果，模型参数里的 id 不进入 meta', () => {
  const user = planAgentTurn({
    kind: 'user',
    userInputs: [{ inputId: 'in1' }],
  });
  const forged = finishAgentTurn({
    turnId: 'turn-forged',
    plan: user,
    rounds: [{
      text: '',
      toolCalls: [{
        name: 'post_reply',
        input: { text: '收到', replyTo: ['input-in1'], memoryUsed: ['forged'], memoryLearned: ['forged'] },
        result: { ok: true },
      }],
    }],
  });
  assert.equal(forged.messages[1].meta, undefined);

  const spoken = finishAgentTurn({
    turnId: 'turn-memory',
    plan: user,
    memoryUsed: ['mem-turn'],
    rounds: [{
      text: '',
      toolCalls: [
        { name: 'memory_remember', input: {}, result: { ok: true, id: 'mem-new' } },
        {
          name: 'post_reply',
          input: { text: '记下了', replyTo: ['input-in1'] },
          result: JSON.stringify({
            ok: true,
            meta: { memoryUsed: ['mem-used'], memoryLearned: [], surfacing: 'silent' },
          }),
        },
      ],
    }],
  });
  assert.deepEqual(spoken.messages[1].meta.memoryUsed, ['mem-used']);
  assert.deepEqual(spoken.messages[1].meta.memoryLearned, ['mem-new']);
  assert.equal(spoken.messages[1].meta.surfacing, 'silent');
  assert.equal(spoken.messages[1].meta.unread, false);

  const fallback = finishAgentTurn({
    turnId: 'turn-fallback',
    plan: user,
    memoryUsed: ['mem-turn'],
    rounds: [
      { text: '先看', toolCalls: [{ name: 'memory_remember', input: {}, result: { outputPreview: { legacyResult: { output: JSON.stringify({ ok: true, id: 'mem-nested' }) } } } }] },
      { text: '一起处理', toolCalls: [] },
    ],
  });
  assert.equal(fallback.messages[1].fallback, true);
  assert.deepEqual(fallback.messages[1].meta.memoryUsed, ['mem-turn']);
  assert.deepEqual(fallback.messages[1].meta.memoryLearned, ['mem-nested']);
});


test('current input anchors cannot be inherited from context on wake or later user turns', () => {
  const context = { inputAnchors: [{ messageId: 'old', text: 'urgent' }], sources: ['memory'] };
  const wake = planAgentTurn({ kind: 'wake', context });
  assert.deepEqual(wake.turnProfile.context, { sources: ['memory'] });
  const user = planAgentTurn({ kind: 'user', context, userInputs: [{ inputId: 'new', text: 'ordinary' }] });
  assert.deepEqual(user.turnProfile.context.inputAnchors, [{ messageId: 'input-new', text: 'ordinary' }]);
  assert.equal(context.inputAnchors[0].messageId, 'old');
});
