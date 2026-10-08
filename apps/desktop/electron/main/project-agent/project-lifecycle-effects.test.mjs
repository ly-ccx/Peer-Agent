import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectLifecycleEffects } from './project-lifecycle-effects.mjs';

for (const readable of [false, true]) {
  test(`verified familiarity memory requires readable Evidence (${readable})`, async () => {
    const writes = [];
    const settled = [];
    let profile = { familiarize: { sessionId: 's1', memoryRecorded: false } };
    const effects = createProjectLifecycleEffects({
      profileStore: { read: () => profile, save: value => { profile = value; } },
      lifecycle: { recordVerifiedFindings: (workspaceId, findings) => {
        writes.push({ workspaceId, findings });
        return { ok: true, items: [{ id: 'memory-1' }] };
      } },
      supervisor: {
        acceptance: () => ({ verdict: { outcome: 'passed', checks: [{ passed: true }],
          evidenceRefs: ['file-ref', 'wrapper-ref'] } }),
        get: () => ({ workspaceId: 'w1', status: 'accepted' }),
        settle: async id => { settled.push(id); },
      },
      conversationStore: { updateMessageById() {} },
      resolveConversationId: () => 'parent',
      resolveEvidence: ref => readable && ref === 'file-ref' ? 'observed project fact' : '',
    });
    await effects.onReplied('w1', { id: 'reply', content: 'Project finding', sources: ['s1'] });
    assert.deepEqual(settled, ['s1']);
    assert.equal(profile.familiarize.memoryRecorded, readable);
    assert.deepEqual(writes, readable ? [{ workspaceId: 'w1',
      findings: [{ text: 'Project finding', sourceRefs: ['file-ref'] }] }] : []);
  });
}

test('settling a new reply records its accepted facts for the next wake', async () => {
  const {prepareReplyReport}=await import('@peer-agent/runtime-node');
  let saved;
  const message={id:'reply',kind:'agent_reply',sources:['s1'],marks:[{sessionId:'s1',outcome:'passed',verdictRef:'verdict:s1:passed'}],meta:{sessionStates:[{sessionId:'s1',status:'result_ready'}]}};
  message.meta.reportFactKeys=prepareReplyReport({workspaceId:'w1',message}).keys;
  const effects=createProjectLifecycleEffects({profileStore:{read:()=>({})},supervisor:{get:()=>({workspaceId:'w1',status:'accepted'}),settle:async()=>{}},
    conversationStore:{updateMessageById:(_c,_id,patch)=>{saved={...message,...patch};}},resolveConversationId:()=> 'parent'});
  await effects.onReplied('w1',message);
  assert.equal(saved.meta.sessionStates[0].status,'accepted');
  assert.equal(prepareReplyReport({workspaceId:'w1',message:{...message,meta:{sessionStates:saved.meta.sessionStates}},reportedMessages:[saved]}).suppressed,true);
});

test('disabled memory still settles the verified result without writing familiarity findings', async () => {
  let settled=0;
  const effects=createProjectLifecycleEffects({profileStore:{read:()=>({familiarize:{sessionId:'s1'}})},
    memoryEnabled:()=>false,lifecycle:{recordVerifiedFindings:()=>assert.fail('memory disabled')},
    supervisor:{get:()=>({workspaceId:'w1',status:'accepted'}),settle:async()=>{settled++;}},
    conversationStore:{updateMessageById(){}},resolveConversationId:()=> 'parent'});
  await effects.onReplied('w1',{id:'r',kind:'agent_reply',content:'Done',sources:['s1']});
  assert.equal(settled,1);
});
