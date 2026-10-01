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
