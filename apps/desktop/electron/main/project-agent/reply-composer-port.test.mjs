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

test('post_reply returns recoverable anchor facts and requires a separately validated retry', () => {
  const port = createDesktopReplyComposer({ readDelivery: () => ({ sessionIds: ['s1'],
    sessionStates: [{ sessionId: 's1', status: 'waiting_user' }] }) });
  const draft = { text: '等待跟进', replyTo: ['invented'], sources: ['s1'],
    statusClaims: [{ sessionId: 's1', status: 'waiting_user' }] };
  const rejected = port.postReply(draft, view);
  assert.equal(rejected.error, 'anchor_not_found');
  assert.deepEqual(rejected.messageIds, ['invented']);
  assert.deepEqual(rejected.availableReplyAnchors, [{ messageId: 'u1', text: '做一下' }]);
  assert.equal(rejected.messageId, undefined);
  assert.equal(port.postReply({ ...draft, replyTo: ['u1'], statusClaims: [{ sessionId: 's1', status: 'accepted' }] }, view).error, 'status_claim_mismatch');
  const corrected = port.postReply({ ...draft, replyTo: ['u1'] }, view);
  assert.deepEqual(corrected.message.replyTo, ['u1']);
  assert.deepEqual(corrected.message.meta.sessionStates, [{ sessionId: 's1', status: 'waiting_user' }]);
});

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


test('wake reports deduplicate actual facts across persisted history and current tool receipts', () => {
  const delivery={sessionIds:['s1'],sessionStates:[{sessionId:'s1',status:'accepted'}],
    verdicts:[{sessionId:'s1',outcome:'passed',verdictRef:'verdict:s1:passed',independentVerifier:'passed'}]};
  const port=createDesktopReplyComposer({readDelivery:()=>delivery});
  const args={text:'Delivered',replyTo:['u1'],sources:['s1'],statusClaims:[{sessionId:'s1',status:'accepted'}]};
  const first=port.postReply(args,{...view,currentInputAnchors:[]});
  assert.equal(first.suppressed,undefined);
  assert.equal(first.meta.reportFactKeys.length,1);
  const persisted={...view,currentInputAnchors:[],messages:[...view.messages,first.message]};
  const restarted=createDesktopReplyComposer({readDelivery:()=>delivery});
  assert.equal(restarted.postReply({...args,text:'Same result, different wording'},persisted).suppressed,true);
  assert.equal(port.postReply(args,{...view,currentInputAnchors:['u1'],turnToolCalls:[{name:'post_reply',result:{ok:true,output:first}}]}).suppressed,true);
  assert.equal(port.postReply(args,{...persisted,currentInputAnchors:['u-new']}).suppressed,undefined);
  delivery.sessionStates[0].status='failed';delivery.verdicts[0].outcome='failed';
  assert.equal(port.postReply({...args,statusClaims:[{sessionId:'s1',status:'failed'}]},persisted).suppressed,undefined);
});

test('legacy factual reports suppress unchanged wakes but not a new observation or forged source', () => {
  const legacy={kind:'agent_reply',sources:['s1'],meta:{sessionStates:[{sessionId:'s1',status:'accepted'}]},marks:[{sessionId:'s1',outcome:'passed',verdictRef:'verdict:s1:passed'}]};
  const delivery={sessionIds:['s1'],sessionStates:[{sessionId:'s1',status:'accepted'}],verdicts:[{sessionId:'s1',outcome:'passed',verdictRef:'verdict:s1:passed'}]};
  const port=createDesktopReplyComposer({readDelivery:()=>delivery});
  const context={...view,currentInputAnchors:[],messages:[...view.messages,legacy]};
  const args={text:'Result',replyTo:['u1'],sources:['s1'],statusClaims:[{sessionId:'s1',status:'accepted'}]};
  assert.equal(port.postReply(args,context).suppressed,true);
  assert.equal(port.postReply({...args,sources:['fake'],statusClaims:[{sessionId:'fake',status:'accepted'}]},context).error,'forged_sources');
  delivery.objectiveAnchorIds=['u1'];delivery.objectiveEvidenceRefs=['objective-probe:ws:first'];
  const wake={...context,objectiveWakeIds:['obj']};
  const first=port.postReply({text:'Observed',replyTo:['u1']},wake);
  assert.equal(first.suppressed,undefined);
  wake.messages=[...context.messages,first.message];
  assert.equal(port.postReply({text:'Observed again',replyTo:['u1']},wake).suppressed,true);
  delivery.objectiveEvidenceRefs=['objective-probe:ws:second'];
  assert.equal(port.postReply({text:'Changed',replyTo:['u1']},wake).suppressed,undefined);
});
