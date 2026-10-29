import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationReadProjection } from './conversation-read-projection.mjs';
const child = {id:'child',role:'work_session',workspaceId:'w',delegation:{sessionId:'s'},effort:'high',modelProviderId:'old'};
const frozen = {planId:'p',conversationId:'child',delegationOrigin:{workspaceId:'w',sessionId:'s',modelSelection:{worker:{modelProviderId:'worker',reasoningEffort:'max'},verifier:{modelProviderId:'verifier',reasoningEffort:'low'}}}};
function read(conversation=child, plan=frozen) {
  return createConversationReadProjection({conversationStore:{getConversation:()=>conversation},goalPlanStore:{listPlansByConversation:()=>[{planId:'p'}],getPlan:()=>plan},llmConfigStore:{listProviders:()=>[]}})('child');
}
test('legacy child metadata is projected from frozen worker, without rewriting preferences or borrowing verifier effort',()=>{
  assert.deepEqual(read(),{...child,modelProviderId:'worker',effort:'max'});
  assert.equal(child.effort,'high');
  assert.equal(read(child,{...frozen,delegationOrigin:{...frozen.delegationOrigin,modelSelection:{worker:{modelProviderId:'worker'}}}}).effort,'default');
});
test('ordinary conversations, absent snapshots and foreign task identities retain their own preference',()=>{
  assert.equal(read({...child,role:'project_agent'}).effort,'high');
  for(const plan of [null,{...frozen,conversationId:'foreign'}, {...frozen,delegationOrigin:{...frozen.delegationOrigin,workspaceId:'other'}}, {...frozen,delegationOrigin:{...frozen.delegationOrigin,sessionId:'other'}}]) assert.equal(read(child,plan),child);
});

test('context accounting follows the frozen worker window, retaining occupied-token truth',()=>{
  const snapshot={version:1,contextWindow:100,inputBudget:100,compactionThresholdTokens:80,percent:24,authoritativeInputTokens:24};
  const projection=createConversationReadProjection({conversationStore:{getConversation:()=>({...child,contextSnapshot:snapshot})},
    goalPlanStore:{listPlansByConversation:()=>[{planId:'p'}],getPlan:()=>frozen},
    llmConfigStore:{listProviders:()=>[{id:'old',contextWindow:100},{id:'worker',contextWindow:200}]}});
  const view=projection('child');assert.equal(view.modelProviderId,'worker');assert.equal(view.contextSnapshot.contextWindow,200);
  assert.equal(view.contextSnapshot.percent,12);assert.equal(view.contextSnapshot.authoritativeInputTokens,24);assert.equal(snapshot.contextWindow,100);
});
