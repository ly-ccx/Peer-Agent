import {createWatchState,createWatchRunner,createWatchProbeRuntime,mapObjectiveObservationEvent} from '@peer-agent/runtime-node';
import {runObjectiveProbeTurn} from './objective-probe-turn.mjs';
/** Owns device observation assembly and factual delivery; the project runner owns cognition. */
export function createDesktopObjectiveWatchHost({rootDir,store,ownsProject,isReady,resolveWorkspacePath,readSessions,agentTurnExecutor,projectPolicy,inbox,wake,onChanged=()=>{},now=()=>new Date().toISOString()}={}){
 const state=createWatchState({rootDir,now}),canObserve=workspaceId=>ownsProject(workspaceId)&&isReady(workspaceId);
 const probeRuntime=createWatchProbeRuntime({resolveObjective:(ws,id)=>store.get(ws,id),resolveWorkspacePath,canObserve,readSessions,
  runAgentProbe:request=>runObjectiveProbeTurn({request,agentTurnExecutor,projectPolicy:projectPolicy?.(request.workspaceId)}),now});
 const runner=createWatchRunner({store,state,probeRuntime,canObserve,canRegister:ownsProject,resolveWorkspacePath,now,
  emitSignal:input=>{const item=store.get(input.workspaceId,input.objectiveId),event=mapObjectiveObservationEvent({...input,deadline:item?.deadline});if(!event)return;
   inbox.append(input.workspaceId,[event]);onChanged(input.workspaceId);wake?.(input.workspaceId);},
  onObserved:input=>onChanged(input.workspaceId),
  onError:input=>{if(input.workspaceId)onChanged(input.workspaceId);}});
 return {state,runner,restore:workspaceId=>runner.reconcile(workspaceId,{run:false}),stopWorkspace:runner.stopWorkspace,
  changed:workspaceId=>{void runner.reconcile(workspaceId).then(()=>onChanged(workspaceId)).catch(()=>onChanged(workspaceId));},
  start:runner.start,dispose:runner.dispose,decorateView:runner.runtimeView,
  resolveEvidence:ref=>state.readEvidence(ref),
  deliveryFacts(view){
   const records=(view?.objectiveWakeEvents || []).filter(event=>event.workspaceId===view.workspaceId&&event.kind==='objective_signal').flatMap(event=>{
    const evidence=state.readEvidence(state.evidenceRef(view.workspaceId,event.executionKey || ''));
    return evidence&&evidence.objectiveId===event.objectiveId&&evidence.watchId===event.watchId&&evidence.execution?.result?.status==='success'?[{event,evidence}]:[];
   });
   if(!records.length)return {};
   const urgent=records.find(record=>record.evidence.observation.severity==='urgent'),chosen=urgent || records[0];
   const objective=store.get(view.workspaceId,chosen.evidence.objectiveId),at=chosen.evidence.observation.observedAt;
   return {objectiveAnchorIds:[...new Set(records.map(record=>store.get(view.workspaceId,record.evidence.objectiveId)?.originMessageId).filter(Boolean))],objectiveEvidenceRefs:records.map(record=>record.evidence.evidenceRef),objectiveEvent:{origin:'objective_signal',kind:urgent?'objective_risk':'observation',severity:chosen.evidence.observation.severity,novelty:true,
    deadlineImminent:!!objective?.deadline&&Date.parse(objective.deadline)-Date.parse(at)<=86_400_000}};
  },
  readEvidenceBody(ref){const record=state.readEvidence(ref);if(!record)return null;const text=JSON.stringify({observation:record.observation,call:record.execution.call,grant:record.execution.grant,result:record.execution.result},null,2);return {kind:'text',title:'Objective observation',text:text.slice(0,64_000),truncated:text.length>64_000};}};
}
