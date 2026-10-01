import type {createTuiProjectHost} from './tui-project-host.ts';
import type {createTuiProjectClient} from './tui-project-client.ts';

/** User controls call local application ports. They do not become model tool calls. */
export async function runProjectCardAction(host:ReturnType<typeof createTuiProjectHost>,client:ReturnType<typeof createTuiProjectClient>,action:any) {
  const workspaceId=host.workspaceId(), payload=action?.payload ?? {};
  if(!workspaceId)return {ok:false,error:'not_found'};
  if(action.channel==='project-agent:submit-input') {
    const text=typeof payload.text==='string'?payload.text.trim():'';
    const answerTo=typeof payload.answerTo==='string'?payload.answerTo:'';
    if(!text)return {ok:false,error:'answer_required'};
    const sessionId=/^card:question:([^:]+):/.exec(answerTo)?.[1] ?? '';
    const session=host.supervisor.get({sessionId}) as any;
    const handoff= session?.workspaceId===workspaceId ? host.supervisor.deliveryFacts(sessionId) as any : null;
    const handoffAnswer=handoff?.questionId && answerTo===`card:question:${sessionId}:${handoff.questionId}` && handoff.accepted;
    if(handoffAnswer && !host.holdsLease(workspaceId))return {ok:false,error:'desktop_approval_required'};
    const receipt=client.submit(text,{answerTo});
    if(handoffAnswer){const result=await host.supervisor.handleHandoffAnswer({workspaceId,sessionId,answerTo,text}) as unknown as {error?:string};if(result?.error)return {ok:false,error:result.error};}
    return {ok:true,inputId:receipt.inputId};
  }
  if(!host.holdsLease(workspaceId))return {ok:false,error:'desktop_approval_required'};
  if(action.channel==='project-agent:decide-approval')return client.decide(payload.approvalId,payload.decision==='approve'?'approve':'deny',payload.duration==='task'?'task':'once');
  if(action.channel==='project-agent:confirm-result'){
    const session=host.supervisor.get({sessionId:payload.sessionId}) as any;
    if(session?.workspaceId!==workspaceId)return {ok:false,error:'workspace_mismatch'};
    return await host.supervisor.confirmResult(payload.sessionId) ?? {ok:false,error:'not_found'};
  }
  if(action.channel==='project-agent:start-familiarize')return await host.lifecycle.startFamiliarize(workspaceId);
  if(action.channel==='project-agent:accept-readme')return await host.lifecycle.acceptReadme(workspaceId);
  if(action.channel==='project-memory:restore' && payload.resolveConflict===true)return host.memory.resolveConflict({workspaceId,id:payload.id});
  if(action.channel==='project-agent:retry'){
    const profile=host.profiles.read(workspaceId), messages=host.conversations.getPersistedConversationHistory?.(profile?.agentConversationId)?.messages ?? [];
    const turn=messages.find((row:any)=>row.id===payload.turnId && row.kind==='agent_turn') as any;
    if(!turn)return {ok:false,error:'not_found'};
    const card=messages.find((row:any)=>row.turnId===payload.turnId && row.card==='agent_unavailable');
    if(!card || messages.slice(messages.indexOf(card)+1).some((row:any)=>row.kind==='agent_turn'))return {ok:false,error:'stale_turn'};
    await host.tick();const runner=host.host.runnerFor(workspaceId);
    if(!runner)return {ok:false,error:'recovery_pending'};
    if(runner.parked())await runner.retry();else if(turn.userInputs?.length)await runner.enqueueUserInputs(turn.userInputs);else await runner.retry();
    return {ok:runner.status()!=='error'};
  }
  return {ok:false,error:'invalid_action'};
}
