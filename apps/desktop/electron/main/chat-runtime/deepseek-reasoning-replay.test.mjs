import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { agentLoopOpenAI } from './openai-agent-loop.mjs';
import { createToolContext } from './tool-orchestrator.mjs';
import { createRuntimeToolProjection } from '../tools/index.mjs';

test('production DeepSeek loop retains raw reasoning through tools and a durable slice, without tool replay', async () => {
 const root=mkdtempSync(path.join(tmpdir(),'peer-deepseek-replay-'));
 const oldFetch=globalThis.fetch, oldTrace=process.env.PEER_AGENT_PROVIDER_TRACE;
 const requests=[], events=[], reads=[]; let checkpoint;
 const file=path.join(root,'README.md');writeFileSync(file,'REAL_FILE_RESULT');
 const {registry,projection}=createRuntimeToolProjection({projectionOptions:{mode:'project_agent'}});
 globalThis.fetch=async (_url,init)=>{
  const body=JSON.parse(init.body);requests.push(body);const n=requests.length;
  assert.ok(n<=3);
  assert.deepEqual(body.messages.filter(row=>row.role==='system').map(row=>row.content),[n===1?'OLD_HOST_CONTEXT':'CURRENT_WAKE_CONTEXT']);
  for(const assistant of body.messages.filter(row=>row.role==='assistant')) assert.equal(typeof assistant.reasoning_content,'string');
  if(n>1) {
   assert.equal(body.messages.find(row=>row.tool_calls?.some(call=>call.id==='read-1')).reasoning_content,'native thinking 1\nverbatim');
   assert.ok(body.messages.some(row=>row.role==='tool'&&row.tool_call_id==='read-1'&&row.content.includes('REAL_FILE_RESULT')));
  }
  const delta=n<3?{role:'assistant',reasoning_content:`native thinking ${n}\nverbatim`,tool_calls:[{index:0,id:`read-${n}`,type:'function',function:{name:'read_file',arguments:JSON.stringify({path:file})}}]}:{role:'assistant',reasoning_content:'native final',content:'REPLAY_OK'};
  return new Response(`data: ${JSON.stringify({choices:[{delta}]})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
 };
 process.env.PEER_AGENT_PROVIDER_TRACE='0';
 const run=(budget,systemPrompt)=>agentLoopOpenAI({baseUrl:'https://fixture.invalid/v1',apiKey:'fixture',model:'deepseek-v4.1-flash',
  systemPrompt,messages:[{role:'user',content:'Read twice and answer.'}],
  tools:[{type:'function',function:{name:'read_file',parameters:{type:'object',properties:{path:{type:'string'}}}}}],
  webContents:{send:(channel,payload)=>{events.push({channel,payload});if(channel==='chat:stream:tool-result')reads.push(payload);}},
  streamId:'replay',conversationId:'c',providerId:'provider',supportsReasoning:true,effort:'max',contextWindow:100000,
  toolContext:{...createToolContext({conversationId:'c',mode:'project_agent'}),turnRole:'project_agent'},workspacePath:root,
  registry,runtimeProjection:projection,executionBudget:budget,
  permissionGate:{createFilePermissionRequester:()=>async()=>({approved:true,granted:true}),createLocalCapabilityPermissionRequester:()=>async()=>({approved:true,granted:true}),createShellApprovalDecider:()=>async()=>({approved:true})}});
 try {
  await run({maxTurns:1,yieldAtTurnLimit:true,onYield:value=>{checkpoint=structuredClone(value);}},'OLD_HOST_CONTEXT');
  assert.ok(checkpoint,'paired native checkpoint persisted at slice boundary');assert.equal(requests.length,1);
  assert.equal(checkpoint.messages.find(row=>row.tool_calls).reasoning_content,'native thinking 1\nverbatim');
  checkpoint.messages.push({role:'system',content:'STALE_SYSTEM_IN_CHECKPOINT'});
  await run({providerCheckpoint:checkpoint},'CURRENT_WAKE_CONTEXT');
  assert.equal(requests.length,3);assert.equal(reads.length,2,'first completed read is never reexecuted');
  assert.equal(events.some(event=>event.channel==='chat:stream:error'),false);
  assert.ok(events.some(event=>event.channel==='chat:stream:delta'&&event.payload.content==='REPLAY_OK'));
 } finally {globalThis.fetch=oldFetch;if(oldTrace===undefined)delete process.env.PEER_AGENT_PROVIDER_TRACE;else process.env.PEER_AGENT_PROVIDER_TRACE=oldTrace;rmSync(root,{recursive:true,force:true});}
});
