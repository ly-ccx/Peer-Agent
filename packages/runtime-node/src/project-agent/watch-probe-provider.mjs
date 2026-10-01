import { createHash,randomUUID } from 'node:crypto';
import { createEvidenceBundle,createRuntimeProjection } from '@peer-agent/runtime-core';
import { createRuntimeSdk } from '@peer-agent/runtime-sdk';
import { createNodeRuntimeHostAdapter } from '../host-adapter.ts';
import { createPermissionGrant,createFailedClientToolResult } from '../tool-result-factory.mjs';
import { probeGit } from './probes/git-probe.mjs';
import { probeFile,expandWatchPaths } from './probes/file-probe.mjs';
import { probeCi } from './probes/ci-probe.mjs';
const CAPABILITY_ID='local.objective.observe';
export const WATCH_PROBE_MANIFEST=Object.freeze({capabilityId:CAPABILITY_ID,name:'objective_observe',displayName:'Observe project watch',riskLevel:'L1_local_read',
  inputSchema:{type:'object',properties:{objectiveId:{type:'string'},watchId:{type:'string'},executionKey:{type:'string'}},required:['objectiveId','watchId','executionKey'],additionalProperties:false}});

/** Observe adapter: declarations come from the owned store, never from caller-supplied command/path or claimed results. */
export function createWatchProbeProvider({resolveObjective,resolveWorkspacePath,canObserve,readSessions=()=>[],runAgentProbe=null,now=()=>new Date().toISOString()}={}) {
 async function executeCapability(request,context={}){
  const call=request.call || {},input=call.arguments || {};
  const objective=typeof input.objectiveId==='string'?resolveObjective(context.workspaceId,input.objectiveId):null;
  const watch=objective?.watches?.find(w=>w.watchId===input.watchId);
  const permitted=call.capabilityId===CAPABILITY_ID&&request.projectionId==='objective-watch-readonly-v1'&&watch&&objective.status==='active'&&!objective.pendingConfirmation
   &&canObserve(context.workspaceId)===true&&!context.signal?.aborted&&typeof input.executionKey==='string'&&input.executionKey.length<=500
   &&Object.keys(input).every(key=>['objectiveId','watchId','executionKey'].includes(key));
  const grant={...createPermissionGrant({toolCallId:call.toolCallId,granted:!!permitted,scope:CAPABILITY_ID}),reason:'objective_observe',preset:'observe',workspaceId:context.workspaceId,objectiveId:input.objectiveId,watchId:input.watchId};
  let observation;
  if(!permitted)observation={ok:false,unavailableReason:context.signal?.aborted?'cancelled':'observe_not_authorized'};
  else {
   const workspacePath=resolveWorkspacePath(context.workspaceId),probe=watch.probe;
   try{
    if(probe?.type==='agent')observation=typeof runAgentProbe==='function'?await runAgentProbe({workspaceId:context.workspaceId,workspacePath,objectiveId:objective.objectiveId,watchId:watch.watchId,question:probe.question,signal:context.signal}):{ok:false,unavailableReason:'agent_probe_unavailable'};
    else if(probe?.type==='deterministic'){
     const adapters={git_ref:()=>probeGit({workspacePath,ref:probe.spec.ref,signal:context.signal}),file_hash:()=>probeFile({workspacePath,relative:probe.spec.path,signal:context.signal}),
      command:()=>probe.spec.command==='gh_run_list'?probeCi({workspacePath,workflow:probe.spec.workflow,signal:context.signal}):{ok:false,unavailableReason:'probe_not_allowlisted'}};
     observation=await adapters[probe.check]?.() || {ok:false,unavailableReason:'probe_invalid'};
    }else if(watch.source?.type==='git')observation=await probeGit({workspacePath,...watch.source,signal:context.signal});
    else if(watch.source?.type==='files'){
     const files=expandWatchPaths(workspacePath,watch.source.paths).files,parts=files.map(relative=>probeFile({workspacePath,relative,signal:context.signal}));
     if(parts.some(part=>!part.ok))observation={ok:false,unavailableReason:parts.find(part=>!part.ok).unavailableReason};
     else {const value=JSON.stringify(files.map((file,i)=>[file,parts[i].digest]));observation={ok:true,digest:createHash('sha256').update(value).digest('hex'),summary:`${files.length} watched files`,value:createHash('sha256').update(value).digest('hex'),succeeded:true,severity:'info'};}
    }else if(watch.source?.type==='task_event'){
     const owned=new Set(objective.milestones.flatMap(m=>m.sessionIds));const matches={failed:row=>row.status==='failed',ended:row=>['completed','accepted','rejected','cancelled','failed'].includes(row.status),verified:row=>row.status==='accepted'||row.verdict?.outcome==='passed'&&row.verdict?.independentVerifier==='passed'};const rows=readSessions(context.workspaceId).filter(row=>owned.has(row.sessionId)&&matches[watch.source.filter]?.(row)).sort((a,b)=>a.sessionId.localeCompare(b.sessionId)).map(row=>({sessionId:row.sessionId,status:row.status}));
     const value=JSON.stringify(rows);observation={ok:true,digest:createHash('sha256').update(value).digest('hex'),summary:`${rows.length} related tasks`,value,succeeded:rows.length>0&&rows.every(row=>row.status==='accepted'),severity:rows.some(row=>row.status==='failed')?'urgent':'info'};
    }else observation={ok:false,unavailableReason:'probe_invalid'};
   }catch{observation={ok:false,unavailableReason:'probe_failed'};}
  }
  if(context.signal?.aborted)observation={ok:false,unavailableReason:'cancelled'};
  const status=!grant.granted?'denied':observation.ok?'success':observation.unavailableReason==='cancelled'?'cancelled':'failed';
  return {call,grant,result:{toolCallId:call.toolCallId,status,completedAt:now(),outputPreview:{tool:'objective_observe',observation},
   evidence:createEvidenceBundle({evidenceId:`objective-probe-${call.toolCallId}`,toolCallId:call.toolCallId,summary:observation.summary || observation.unavailableReason,locale:'en-US',returnedToCloud:false,dataLevel:'D1_internal'})}};
 }
 return {providerId:'local.objective',capabilityIds:[CAPABILITY_ID],capabilities:[WATCH_PROBE_MANIFEST],executeCapability};
}

export function createWatchProbeRuntime(options){
 const provider=createWatchProbeProvider(options),projection=createRuntimeProjection([{...WATCH_PROBE_MANIFEST,modeScopes:['objective_probe']}],{mode:'objective_probe'});
 const host=createNodeRuntimeHostAdapter({workspaceRoot:'',providerExecutor:{execute:(request,context)=>{
  if(!projection.tools.some(tool=>tool.capabilityId===request.call?.capabilityId))return null;
  return provider.executeCapability(request,context);
 }},sessionProvider:{getSession:()=>({locale:'en-US'})},resultFactory:{createPermissionGrant,createFailedResult:createFailedClientToolResult}});
 const sdk=createRuntimeSdk({host});
 return {provider,projection,subscribe:sdk.subscribe,async execute({workspaceId,objectiveId,watchId,executionKey,signal}){
  const call={toolCallId:randomUUID(),capabilityId:CAPABILITY_ID,arguments:{objectiveId,watchId,executionKey}};
  return sdk.execute({call,projectionId:'objective-watch-readonly-v1',sessionId:`objective-watch:${objectiveId}`,conversationId:null},{workspaceId,signal});
 }};
}
