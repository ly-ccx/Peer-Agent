// Development oracle only; never loaded or launched by peer-native.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { normalizeConversationExecution, conversationExecutionPermitsNewRun } from '../../packages/protocol/src/conversation-execution.ts';
const owner = {bootId:'boot',pid:101,pidStart:'start',hostId:'host',acquiredAt:'2026-11-18T00:00:00.000Z'};
const identity = {kind:'conversation',conversationId:'conversation',streamId:'stream'};
const base = {schemaVersion:1,identity,engine:'peer-native',owner,revision:1,phase:'active',pendingTools:[],handles:[],usage:null,
  unknownUsage:false,attribution:{id:'stream'},usageCommitted:true,updatedAt:owner.acquiredAt};
const pending = {toolCallId:'call',dispatchId:'dispatch',messageId:'answer',capabilityId:'local.file.read',argsDigest:'0'.repeat(64),phase:'dispatching',declaredScopes:[]};
const commandProcess = {schemaVersion:1,kind:'command',handleId:'handle',toolCallId:'call',dispatchId:'dispatch',execution:identity,
  generation:0,state:'not_started',owner};
const stop = {owner,observedAt:owner.acquiredAt,runnerIdle:true,admissionClosed:true,handlesEnded:true};
const usage = {usageScope:'runtime_turn',providerRequestCount:2,inputTokens:12,outputTokens:3,cacheReadTokens:4,cacheWriteTokens:1,totalTokens:20};
const cases: unknown[] = [];
function add(name: string, modify: (r: any) => void, valid=true, permits=false) {
  const input=structuredClone(base); modify(input); const before=JSON.stringify(input);
  if (valid) {assert.deepEqual(normalizeConversationExecution(input),input,name);assert.equal(conversationExecutionPermitsNewRun(input),permits,name);}
  else assert.throws(()=>normalizeConversationExecution(input),/conversation_execution_invalid/,name);
  assert.equal(JSON.stringify(input),before);cases.push({name,input,valid,permits});
}
add('active',()=>{});
add('ts-owner',r=>{r.engine='peer-ts';});
add('stopped',r=>Object.assign(r,{phase:'stopped',stop}),true,true);
add('unknown-keeps-owner',r=>Object.assign(r,{phase:'recovery_required',stop,pendingTools:[pending]}));
add('known-usage',r=>Object.assign(r,{usage,unknownUsage:true,usageCommitted:false}));
add('actual-billing-attribution',r=>{r.attribution={id:'stream',streamId:'stream',at:owner.acquiredAt,modelProviderId:'group::provider',role:'chat'};});
add('command-not-started',r=>{r.pendingTools=[{...pending,nativeProcess:commandProcess}];});
add('command-running',r=>{r.pendingTools=[{...pending,nativeProcess:{...commandProcess,generation:1,state:'running',child:{...owner,pid:102}}}];});
add('optional-null',r=>Object.assign(r,{stop:null,pendingTools:[{...pending,nativeProcess:null}]}));
add('ended-handle',r=>Object.assign(r,{phase:'stopped',stop,handles:[{handleId:'h',toolCallId:'call',state:'ended',metadata:{}}]}),true,true);
const hookDigest='1'.repeat(64);
const hookProcess={...commandProcess,handleId:'hook-handle'};
const hookObservation={id:'review',hookId:'review',event:'PreToolUse',ruleDigest:hookDigest,handleId:hookProcess.handleId,
  decision:'ask',outcome:'ok',reason:null,exitCode:0,durationMs:16};
function hookRun(r: any, stage: 'ready'|'running'|'observed'|'unknown') {
  r.pendingTools=[{...pending,phase:'prepared'}];
  const child={...owner,pid:102};
  const process=stage==='ready' ? hookProcess : stage==='running'
    ? {...hookProcess,generation:1,state:'running',child}
    : {...hookProcess,generation:1,state:'ended',child,stopObservation:stage==='observed'?'owned_completion':'owner_dead_group_absent'};
  r.handles=[{handleId:hookProcess.handleId,toolCallId:'call',state:process.state==='ended'?'ended':'active',
    metadata:{kind:'hook',nativeHook:{schemaVersion:1,event:'PreToolUse',ruleDigest:hookDigest,process:structuredClone(process),
      ...(stage==='observed'?{observation:structuredClone(hookObservation)}:{})}}}];
}
add('hook-pre-can-own-a-prepared-call',r=>hookRun(r,'ready'));
add('hook-running-owns-actual-child',r=>hookRun(r,'running'));
add('hook-observation-awaits-original-publication',r=>hookRun(r,'observed'));
add('hook-stopped-group-with-unknown-result',r=>{hookRun(r,'unknown');r.phase='stopping';});
add('hook-post-requires-provider-dispatch',r=>{hookRun(r,'ready');r.handles[0].metadata.nativeHook.event='PostToolUse';},false);
add('hook-must-match-original-dispatch',r=>{hookRun(r,'ready');r.pendingTools[0].dispatchId='foreign';},false);
add('hook-owner-must-match',r=>{hookRun(r,'ready');r.handles[0].metadata.nativeHook.process.owner={...owner,pid:103};},false);
add('hook-observed-end-requires-a-receipt',r=>{hookRun(r,'observed');delete r.handles[0].metadata.nativeHook.observation;},false);
add('hook-recovery-cannot-invent-observed-decision',r=>{hookRun(r,'unknown');r.handles[0].metadata.nativeHook.observation=hookObservation;},false);
add('hook-observation-must-match-rule',r=>{hookRun(r,'observed');r.handles[0].metadata.nativeHook.observation.ruleDigest='2'.repeat(64);},false);
add('hook-cannot-retain-raw-stdout',r=>{hookRun(r,'observed');r.handles[0].metadata.nativeHook.observation.stdout='unexpected';},false);
function shellRun(r: any, state: 'not_started'|'starting'|'running'|'ended') {
  const process = {...commandProcess, handleId:'shell_12345678-1234-4abc-8def-123456789012', state,
    generation:state==='not_started'?0:1,
    ...(state==='running'||state==='ended'?{child:{...owner,pid:102}}:{}),
    ...(state==='ended'?{stopObservation:'owner_dead_group_absent'}:{})};
  r.pendingTools=[{...pending,capabilityId:'local.shell.exec',nativeProcess:structuredClone(process)}];
  r.handles=[{handleId:process.handleId,toolCallId:process.toolCallId,state:state==='ended'?'ended':'active',
    metadata:{kind:'shell_background',nativeShell:{schemaVersion:1,process:structuredClone(process)}}}];
}
add('background-shell-registered-before-spawn',r=>shellRun(r,'not_started'));
add('background-shell-starting-keeps-the-dispatch',r=>shellRun(r,'starting'));
add('background-shell-running-keeps-exact-child',r=>shellRun(r,'running'));
add('background-shell-can-coexist-with-other-original-dispatches',r=>{
  shellRun(r,'running');
  const first=r.handles[0], second=structuredClone(first);
  const p=second.metadata.nativeShell.process;
  p.handleId=second.handleId='shell_12345678-1234-4abc-8def-123456789013';
  p.toolCallId=second.toolCallId='background-second-call';
  p.dispatchId='background-second-dispatch';
  p.child.pid=103;
  r.handles.push(second);
  r.pendingTools.push({...r.pendingTools[0],toolCallId:p.toolCallId,dispatchId:p.dispatchId,
    messageId:'background-second-message',nativeProcess:structuredClone(p)});
  r.pendingTools.push({...pending,toolCallId:'new-tool-call',dispatchId:'new-tool-dispatch',messageId:'new-tool-message',phase:'prepared'});
});
add('background-shell-null-optional-process-fields-roundtrip',r=>{
  shellRun(r,'starting');r.handles[0].metadata.nativeShell.process.child=null;r.pendingTools[0].nativeProcess.stopObservation=null;
});
add('background-shell-group-ended-retains-unknown',r=>{
  shellRun(r,'ended');r.phase='recovery_required';r.stop=stop;r.pendingTools[0].phase='outcome_unknown';
});
add('background-shell-rejects-foreign-run',r=>{shellRun(r,'running');r.handles[0].metadata.nativeShell.process.execution={...identity,streamId:'other'};},false);
add('background-shell-rejects-unrelated-claim',r=>{shellRun(r,'starting');r.pendingTools[0].capabilityId='local.file.read';},false);
add('background-shell-requires-original-dispatch',r=>{shellRun(r,'running');r.pendingTools=[];},false);
add('background-shell-rejects-own-host-as-child',r=>{
  shellRun(r,'running');r.handles[0].metadata.nativeShell.process.child={...owner};r.pendingTools[0].nativeProcess.child={...owner};
},false);
add('background-shell-mirror-must-advance-with-process',r=>{
  shellRun(r,'running');r.pendingTools[0].nativeProcess.child.pid=103;
},false);
add('background-shell-future-version-blocks',r=>{shellRun(r,'running');r.handles[0].metadata.nativeShell.schemaVersion=2;},false);
for (const [name,modify] of [
 ['future-schema',(r:any)=>{r.schemaVersion=2;}],['extra-root',(r:any)=>{r.extra=true;}],
 ['fake-goal',(r:any)=>{r.identity={planId:'p',sessionId:'s',executionEpoch:'e',generation:'g',goalRevision:1};}],
 ['missing-kind',(r:any)=>{delete r.identity.kind;}],['identity-extra',(r:any)=>{r.identity.future=true;}],
 ['invalid-id',(r:any)=>{r.identity.conversationId='../escape';}],['owner-extra',(r:any)=>{r.owner.extra=true;}],
 ['pid-zero',(r:any)=>{r.owner.pid=0;}],['missing-owner-start',(r:any)=>{delete r.owner.pidStart;}],
 ['revision-fraction',(r:any)=>{r.revision=1.5;}],['revision-unsafe',(r:any)=>{r.revision=2**53;}],
 ['unknown-phase',(r:any)=>{r.phase='done';}],['array-engine',(r:any)=>{r.engine=['peer-native'];}],
 ['foreign-billing-id',(r:any)=>{r.attribution.id='other';}],['foreign-billing-stream',(r:any)=>{r.attribution.streamId='other';}],
 ['bot-role',(r:any)=>{r.attribution.role='bot';}],['cost-negative',(r:any)=>{r.attribution.estimatedCostUsd=-1;}],
 ['usage-scope',(r:any)=>{r.usage={...usage,usageScope:'conversation_lifetime'};}],
 ['usage-total',(r:any)=>{r.usage={...usage,totalTokens:21};}],['usage-extra',(r:any)=>{r.usage={...usage,extra:true};}],
 ['usage-missing',(r:any)=>{delete r.usage;}],['usage-partial',(r:any)=>{r.usage={usageScope:'runtime_turn',providerRequestCount:1,totalTokens:0};}],
 ['usage-no-request',(r:any)=>{r.usage={...usage,providerRequestCount:0};}],
 ['stop-owner-extra',(r:any)=>Object.assign(r,{phase:'stopped',stop:{...stop,owner:{...owner,extra:true}}})],
 ['stop-foreign-owner',(r:any)=>Object.assign(r,{phase:'stopped',stop:{...stop,owner:{...owner,pid:102}}})],
 ['stop-false',(r:any)=>Object.assign(r,{phase:'stopped',stop:{...stop,runnerIdle:false}})],
 ['active-stopped',(r:any)=>{r.stop=stop;}],['stopped-without-stop',(r:any)=>{r.phase='stopped';}],
 ['stopped-unpaid',(r:any)=>Object.assign(r,{phase:'stopped',stop,usageCommitted:false})],
 ['stopped-pending',(r:any)=>Object.assign(r,{phase:'stopped',stop,pendingTools:[pending]})],
 ['duplicate-pending',(r:any)=>{r.pendingTools=[pending,pending];}],['bad-digest',(r:any)=>{r.pendingTools=[{...pending,argsDigest:'g'.repeat(64)}];}],
 ['unknown-scope',(r:any)=>{r.pendingTools=[{...pending,declaredScopes:[{kind:'automatic'}]}];}],
 ['prepared-process',(r:any)=>{r.pendingTools=[{...pending,phase:'prepared',nativeProcess:commandProcess}];}],
 ['process-foreign-execution',(r:any)=>{r.pendingTools=[{...pending,nativeProcess:{...commandProcess,execution:{...identity,streamId:'foreign'}}}];}],
 ['process-owner-extra',(r:any)=>{r.pendingTools=[{...pending,nativeProcess:{...commandProcess,owner:{...owner,extra:true}}}];}],
 ['process-future',(r:any)=>{r.pendingTools=[{...pending,nativeProcess:{...commandProcess,extra:true}}];}],
 ['duplicate-handle',(r:any)=>{r.handles=[{handleId:'h',toolCallId:'c',state:'active',metadata:{}},{handleId:'h',toolCallId:'c',state:'active',metadata:{}}];}],
 ['stopped-live-handle',(r:any)=>Object.assign(r,{phase:'stopped',stop,handles:[{handleId:'h',toolCallId:'c',state:'active',metadata:{}}]})],
] as const) add(name,modify,false);
const file=new URL('../../packages/protocol/contracts/native-cli/conversation-execution.json',import.meta.url);
const encoded=JSON.stringify({version:1,cases},null,2)+'\n';
if(process.argv.includes('--write'))writeFileSync(file,encoded);else assert.equal(readFileSync(file,'utf8'),encoded,'ordinary execution contract drift');
console.log(`${cases.length} conversation execution vectors match the actual TypeScript decoder.`);
