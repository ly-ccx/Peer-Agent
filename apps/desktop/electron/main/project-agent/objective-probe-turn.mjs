import {createHash,randomUUID} from 'node:crypto';
import {createCollectingSink} from '../agent-host/turn-sinks.mjs';
/** Ephemeral Explorer expression; real tool executions are collected separately from model text. */
export async function runObjectiveProbeTurn({request,agentTurnExecutor,projectPolicy=null,timeoutMs=60_000}={}){
 const route=agentTurnExecutor.resolveGoalRole({role:'objective_probe',workspaceId:request.workspaceId,projectPolicy});
 if(!route?.ok||!route.selection?.modelProviderId)return {ok:false,unavailableReason:'agent_probe_model_unavailable'};
 const sink=createCollectingSink(),executions=[],controller=new AbortController();let calls=0,timedOut=false;
 const abort=()=>controller.abort();request.signal?.addEventListener('abort',abort,{once:true});if(request.signal?.aborted)abort();
 const timeout=setTimeout(()=>{timedOut=true;abort();},timeoutMs);timeout.unref?.();
 try{
  const result=await agentTurnExecutor.runTurn({turnProfile:{role:'objective_probe',workspaceId:request.workspaceId,modelSelection:route.selection},sink,signal:controller.signal,
   messages:[{role:'user',content:request.question}],streamId:randomUUID(),effort:'default',mode:'explorer',conversationId:null,workspacePath:request.workspacePath,modelProviderId:route.selection.modelProviderId,ephemeral:true,
   permissionPolicy:{kind:'objective_probe',workspacePath:request.workspacePath,objectiveId:request.objectiveId,watchId:request.watchId},
   explorerContext:{explorerId:`objective-probe:${request.watchId}`,mission:{question:request.question},workspacePath:request.workspacePath},
   agentProgress:{onToolCall:()=>{if(++calls>8)controller.abort();},onToolExecution:execution=>{executions.push(structuredClone(execution));}}});
  if(controller.signal.aborted)return {ok:false,unavailableReason:request.signal?.aborted?'cancelled':timedOut?'agent_probe_timeout':'agent_probe_tool_limit',toolExecutions:executions};
  if(result?.ok===false||sink.getTerminal()?.channel==='chat:stream:error')return {ok:false,unavailableReason:'agent_probe_failed',toolExecutions:executions};
  const actual=executions.filter(execution=>execution.grant?.granted&&execution.result?.status==='success');
  if(!actual.length)return {ok:false,unavailableReason:'agent_probe_no_evidence',toolExecutions:executions};
  const digest=createHash('sha256').update(JSON.stringify(actual.map(execution=>({capabilityId:execution.call.capabilityId,arguments:execution.call.arguments,status:execution.result.status,outputPreview:execution.result.outputPreview})))).digest('hex');
  return {ok:true,digest,summary:sink.getText().slice(0,2000)||`${actual.length} actual readonly checks`,value:digest,severity:'info',toolExecutions:executions};
 }finally{clearTimeout(timeout);request.signal?.removeEventListener('abort',abort);}
}
