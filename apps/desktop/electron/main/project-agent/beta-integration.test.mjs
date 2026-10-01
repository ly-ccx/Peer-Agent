import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentTurnExecutor } from '../agent-host/agent-turn-executor.mjs';
import { finishAgentTurn, planAgentTurn } from '../../../../../packages/runtime-node/src/project-agent/agent-turn-plan.mjs';
import { createProjectAgentRunner } from '../../../../../packages/runtime-node/src/project-agent/runner.mjs';

function runner(messages, executeTurn) {
  return createProjectAgentRunner({workspaceId:'ws-test',conversationId:'conv-test',inbox:{takeBatch:()=>({events:[]}),commitBatch(){}},
    appendMessage:(_id,m)=>messages.push(m),resolveModel:()=>({modelProviderId:'configured'}),executeTurn});
}

test('rejected post_reply cannot publish forged source refs',()=>{
  const finished=finishAgentTurn({turnId:'t',plan:planAgentTurn({kind:'user',userInputs:[{inputId:'i'}]}),rounds:[{toolCalls:[{
    name:'post_reply',input:{text:'passed',replyTo:['foreign'],sources:['foreign-task']},
    result:{status:'failed',outputPreview:{legacyResult:{success:false,output:JSON.stringify({ok:false,error:'forged_sources'})}}},
  }]}]});
  assert.equal(finished.messages.some(m=>m.content==='passed'),false);
  assert.equal(finished.messages.some(m=>m.sources?.includes('foreign-task')),false);
});

test('rejected status claim cannot escape through final prose fallback',()=>{
  const finished=finishAgentTurn({turnId:'t',plan:planAgentTurn({kind:'user',userInputs:[{inputId:'i'}]}),rounds:[{
    text:'已经自动签收',toolCalls:[{name:'post_reply',input:{text:'已经自动签收'},result:{ok:false,error:'status_claim_mismatch'}}],
  }]});
  assert.equal(finished.messages.some(message=>message.kind==='agent_reply'),false);
  assert.equal(finished.failed,true);
});

test('service terminal errors stay errors, not successful empty replies',async()=>{
  const executor=createAgentTurnExecutor({llmChatService:{sendMessage:async()=>({terminalStatus:'error',toolCallCount:0})}});
  const messages=[];const r=runner(messages,input=>executor.runTurn(input));
  try { await r.enqueueUserInputs([{inputId:'i',text:'hello'}]);assert.equal(r.status(),'error');
    assert.equal(messages.some(m=>m.kind==='agent_reply'),false);assert.ok(messages.some(m=>m.card==='agent_unavailable'));
  } finally {r.dispose()}
});

test('a restarted runner uses distinct turn and reply identities',async()=>{
  const messages=[];for(let index=0;index<2;index++){
    const r=runner(messages,async()=>({text:'hello'}));try{await r.enqueueUserInputs([{inputId:`i${index}`,text:'hello'}])}finally{r.dispose()}
  }
  const ids=messages.filter(m=>m.kind==='agent_reply').map(m=>m.id);assert.equal(new Set(ids).size,2);
});

test('executor exposes the chat service role router',()=>{
  const executor=createAgentTurnExecutor({llmChatService:{sendMessage(){},resolveGoalRole:input=>({ok:true,selection:{modelProviderId:input.role}})}});
  assert.equal(executor.resolveGoalRole({role:'project_agent'}).selection.modelProviderId,'project_agent');
});
