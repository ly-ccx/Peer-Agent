import assert from 'node:assert/strict';
import test from 'node:test';

import { createDesktopReplyComposer } from './reply-composer-port.mjs';
import { installDeliveryFacts, liveDeliveryFacts } from './delivery-facts-port.mjs';

const view = {
  turnId: 'turn-1',
  toolCallOrdinal: 1,
  workspaceId: 'ws-1',
  messages: [{ id: 'u1', kind: 'user_input', role: 'user', content: '做一下' }],
};

test('a completed result requires independent verification before delivery', () => {
  let independentVerifier = 'missing';
  const port = createDesktopReplyComposer({ readDelivery: () => ({ sessionIds: ['s1'],
    sessionStates: [{ sessionId: 's1', status: 'result_ready' }],
    verdicts: [{ sessionId: 's1', outcome: 'passed', independentVerifier }],
  }) });
  const args = { text: 'Result', replyTo: ['u1'], sources: ['s1'],
    statusClaims: [{ sessionId: 's1', status: 'result_ready' }] };
  assert.equal(port.postReply(args, view).error, 'verification_required');
  independentVerifier = 'passed';
  assert.equal(port.postReply(args, view).error, undefined);
});

test('a reply anchored to an unreported completed task cannot omit its source', () => {
  const port=createDesktopReplyComposer({readDelivery:()=>({sessionIds:['s1'],sessionStates:[{sessionId:'s1',status:'result_ready'}],
    unreportedResults:[{sessionId:'s1',anchorMessageId:'u1'}]})});
  const missing=port.postReply({text:'It is done',replyTo:['u1']},view);
  assert.equal(missing.error,'result_source_required');
  assert.deepEqual(missing.sessionStates,[{sessionId:'s1',status:'result_ready'}]);
  assert.equal(port.postReply({text:'Result',replyTo:['u1'],sources:['s1'],statusClaims:[{sessionId:'s1',status:'result_ready'}]},view).error,undefined);
  assert.equal(port.postReply({text:'Other question',replyTo:['u2']},{...view,messages:[...view.messages,{id:'u2',role:'user',kind:'user_input'}]}).error,undefined);
});

function composer() {
  return createDesktopReplyComposer({
    readDelivery: (input) => liveDeliveryFacts().read(input),
  });
}

test('回复按本机器人档位和安静时段送达', () => {
  installDeliveryFacts({
    read: () => ({ proactivity: 'high', botLevel: 'muted', quietHours: true }),
  });
  const muted = composer().postReply({ text: '先记一笔', replyTo: ['u1'] }, view);
  assert.equal(muted.error, undefined);
  assert.equal(muted.surfacing, 'silent');

  installDeliveryFacts({
    read: () => ({ proactivity: 'standard', quietHours: true }),
  });
  const quiet = composer().postReply({ text: '做完了', replyTo: ['u1'] }, view);
  assert.equal(quiet.surfacing, 'message');

  installDeliveryFacts({
    read: () => ({ proactivity: 'standard', quietHours: false }),
  });
  const standard = composer().postReply({ text: '做完了', replyTo: ['u1'] }, view);
  assert.equal(standard.surfacing, 'interrupt');
  installDeliveryFacts(null);
});

test('记忆 id 来自宿主视图，模型参数里的 id 被忽略', () => {
  const reply = composer().postReply({
    text: '做完了',
    replyTo: ['u1'],
    memoryUsed: ['forged'],
    memoryLearned: ['forged'],
  }, {
    ...view,
    memoryIds: ['mem-used'],
    turnToolCalls: [{ name: 'memory_remember', result: { ok: true, id: 'mem-new' } }],
  });
  assert.equal(reply.error, undefined);
  assert.deepEqual(reply.meta.memoryUsed, ['mem-used']);
  assert.deepEqual(reply.meta.memoryLearned, ['mem-new']);
});

test('objective wake cannot borrow a historical user anchor or forge notification urgency', () => {
  const event = {origin:'objective_signal',kind:'observation',severity:'info',novelty:true};
  const port=createDesktopReplyComposer({readDelivery:()=>({proactivity:'standard',objectiveEvent:event,objectiveAnchorIds:['u-objective'],objectiveEvidenceRefs:['objective-probe:ws:actual']})});
  const wake={...view,messages:[...view.messages,{id:'u-objective',kind:'user_input',role:'user'}],currentInputAnchors:[],objectiveWakeIds:['obj']};
  assert.equal(port.postReply({text:'Observed',replyTo:['u1']},wake).error,'current_user_required');
  const reply=port.postReply({text:'Observed',proactive:true,surfacing:{event:{severity:'urgent'}}},wake);
  assert.equal(reply.surfacing,'digest');
  assert.deepEqual(reply.meta.evidenceRefs,['objective-probe:ws:actual']);
  assert.equal(port.postReply({text:'Objective reference',replyTo:['u-objective']},wake).surfacing,'digest');
  event.kind='objective_risk';event.severity='urgent';event.deadlineImminent=true;
  assert.equal(port.postReply({text:'Risk',proactive:true},wake).surfacing,'interrupt');
  assert.equal(port.postReply({text:'User reply',replyTo:['u1']},{...wake,currentInputAnchors:['u1']}).error,undefined);
});
