import { createHash } from 'node:crypto';
import { isCanonicalUserInput } from './user-priority.mjs';
import { validateObjectiveDefinition } from './objective-store.mjs';

const LEVEL = {report_only:0,propose:1,act:2};
const fail = code => ({ok:false,code});
const cleanUserText = text => typeof text==='string' ? text.replace(/```[\s\S]*?```|`[^`]*`|^[ \t]*>.*$|“[^”]*”|「[^」]*」|"[^"\n]*"/gm,'') : '';
export function userAuthorizesObjectiveAutonomy(content,autonomy){
  const text=cleanUserText(content).replace(/不用等我|不必等我|无需等我/g,'');
  if(autonomy==='report_only')return true;
  if(autonomy==='propose')return !/(?:只|仅|才).{0,6}(?:告诉|报告|通知)|report\s+only/i.test(text);
  if(/不要.{0,10}(?:直接|自动)|别.{0,10}(?:修|做)|不能|不允许|等我|先问|ask\s+me|do\s+not|don['’]?t/i.test(text))return false;
  return /(?:发现|出|有).{0,12}(?:直接|自动).{0,6}(?:修|处理|做)|(?:直接|自动)(?:修|处理|推进|动手)|自己(?:推进|处理|做)|automatically\s+(?:fix|handle)|(?:fix|handle).{0,12}(?:automatically|without\s+asking)/i.test(text);
}

/** Owns user provenance, objective scope, transitions and factual achievement; no model execution. */
export function createObjectiveService({store,readConversation,resolveConversationId,canManageWorkspace=()=>true,readSession=()=>null,resolveEvidence=()=>null,onChanged=null}={}) {
  if(!store)throw TypeError('ObjectiveService requires store');
  function scope(view,write=false){return typeof view?.workspaceId==='string'&&(!write||canManageWorkspace(view.workspaceId)===true)&&resolveConversationId(view.workspaceId)===view.conversationId;}
  function currentUser(input,view){
    if(!scope(view,true)||!Array.isArray(view.currentInputAnchors)||!view.currentInputAnchors.includes(input.anchorMessageId))return null;
    return (readConversation(view.conversationId)||[]).find(m=>m.id===input.anchorMessageId&&isCanonicalUserInput(m))||null;
  }
  function owned(input,view){return scope(view)?store.get(view.workspaceId,input.objectiveId):null;}
  function changed(result,workspaceId){if(result.ok&&typeof onChanged==='function')onChanged(workspaceId);return result;}
  function create(input,view={}){
    const anchor=currentUser(input,view);if(!anchor)return fail('CURRENT_USER_REQUIRED');
    const createdBy=input.createdBy || 'user_request',autonomy=input.autonomy || 'propose';
    if(createdBy==='user_request'&&!/(?:目标|持续|盯着|监控|每天|定期|一直|直到|发布前|发版前|稳定下来|(?:CI|构建|测试|test|build).{0,10}(?:挂了|失败|fail)|\bgoal\b|\bmonitor\b|\bwatch\b|\bkeep\b)/i.test(cleanUserText(anchor.content)))return fail('OBJECTIVE_NOT_REQUESTED');
    if(createdBy==='user_request'&&!userAuthorizesObjectiveAutonomy(anchor.content,autonomy))return fail('AUTONOMY_NOT_AUTHORIZED');
    if(createdBy==='agent_proposal'&&autonomy==='act')return fail('AUTONOMY_NOT_AUTHORIZED');
    if(Array.isArray(input.milestones)&&input.milestones.some(m=>m.sessionIds?.length||m.status==='done'))return fail('SESSION_OUT_OF_SCOPE');
    const requestId=createHash('sha256').update(`${view.conversationId}\0${anchor.id}\0${input.title}\0${input.outcome}`).digest('hex');
    const result=store.create({...input,workspaceId:view.workspaceId,projectAgentConversationId:view.conversationId,originMessageId:anchor.id,createdBy,autonomy,
      status:createdBy==='agent_proposal'?'paused':'active',pendingConfirmation:createdBy==='agent_proposal'}, {requestId});
    return changed(result,view.workspaceId);
  }
  function get(input,view){const item=owned(input,view);return item?{ok:true,item,observations:store.observations(view.workspaceId,item.objectiveId).slice(-30)}:fail('NOT_FOUND');}
  function list(_input,view){return scope(view)?{ok:true,items:store.list(view.workspaceId).map(item=>({...item,lastObservation:store.observations(view.workspaceId,item.objectiveId).at(-1)||null}))}:fail('NOT_FOUND');}
  function mutationOptions(input,view){return {expectedVersion:input.expectedVersion??null,requestId:view.commandId||null,fingerprint:view.commandFingerprint||null};}
  function update(input,view){
    if(!scope(view,true))return fail('NOT_HOST');
    const current=owned(input,view);if(!current)return fail('NOT_FOUND');
    if(input.status!==undefined||input.confirmed!==undefined||input.autoAccept!==undefined||input.pendingConfirmation!==undefined)return fail('HOST_FIELDS_FORBIDDEN');
    const raisesAutonomy=input.autonomy!==undefined&&LEVEL[input.autonomy]>LEVEL[current.autonomy];
    const expandsBudget=input.budget&&(input.budget.maxAutoSessionsPerDay>current.budget.maxAutoSessionsPerDay||input.budget.maxProbeRunsPerDay>current.budget.maxProbeRunsPerDay);
    if(raisesAutonomy||expandsBudget){const anchor=currentUser(input,view);if(!anchor)return fail('CURRENT_USER_REQUIRED');
      if(!userAuthorizesObjectiveAutonomy(anchor.content,input.autonomy || current.autonomy))return fail('AUTONOMY_NOT_AUTHORIZED');}
    const patch={};for(const key of ['title','outcome','watches','milestones','successSignals','autonomy','budget','deadline'])if(input[key]!==undefined)patch[key]=input[key];
    const checked=validateObjectiveDefinition({...current,...patch});if(!checked.ok)return checked;
    if(patch.milestones?.some(m=>m.sessionIds?.some(id=>{const session=readSession(id);return !session||session.workspaceId!==view.workspaceId||session.origin?.objectiveId!==current.objectiveId;})))return fail('SESSION_OUT_OF_SCOPE');
    if(patch.milestones?.some(m=>m.status==='done'&&(!m.sessionIds.length||m.sessionIds.some(id=>readSession(id)?.status!=='accepted'))))return fail('MILESTONE_UNPROVEN');
    return changed(store.update(view.workspaceId,current.objectiveId,patch,mutationOptions(input,view)),view.workspaceId);
  }
  function pause(input,view){if(!scope(view,true))return fail('NOT_HOST');const current=owned(input,view);return current?changed(store.update(view.workspaceId,current.objectiveId,{status:'paused'},mutationOptions(input,view)),view.workspaceId):fail('NOT_FOUND');}
  function resume(input,view){
    const current=owned(input,view);if(!current)return fail('NOT_FOUND');const anchor=currentUser(input,view);if(!anchor)return fail('CURRENT_USER_REQUIRED');
    if(current.pendingConfirmation){const text=cleanUserText(anchor.content);if(!/(?:同意|确认|开始|可以|好|yes|confirm|approve|start)/i.test(text)||/(?:不|别|不要|不同意|no\b|don['’]?t)/i.test(text))return fail('CONFIRMATION_REQUIRED');}
    if(!userAuthorizesObjectiveAutonomy(anchor.content,current.autonomy))return fail('AUTONOMY_NOT_AUTHORIZED');
    return changed(store.update(view.workspaceId,current.objectiveId,{status:'active',pendingConfirmation:false},mutationOptions(input,view)),view.workspaceId);
  }
  function achievement(current,evidenceRefs){
    const milestones=current.milestones.filter(m=>m.status!=='dropped'),sessions=milestones.flatMap(m=>m.sessionIds).map(readSession);
    if(milestones.some(m=>!m.sessionIds.length)||sessions.some(s=>!s||s.workspaceId!==current.workspaceId||s.origin?.objectiveId!==current.objectiveId||s.status!=='accepted'))return false;
    const observations=store.observations(current.workspaceId,current.objectiveId);
    if(!sessions.length&&!current.successSignals.length)return false;
    if(current.successSignals.some(signal=>{const observed=observations.filter(o=>o.watchId===signal.watchId).at(-1);return !observed||!observed.evidenceRefs.length||observed.evidenceRefs.some(ref=>resolveEvidence(ref)?.workspaceId!==current.workspaceId)
      ||(signal.operator==='succeeded'?observed.succeeded!==true:signal.operator==='equals'?observed.value!==signal.value:!observed.value?.includes(signal.value));}))return false;
    if(!Array.isArray(evidenceRefs)||!evidenceRefs.length||evidenceRefs.some(ref=>{const record=resolveEvidence(ref);return !record||record.workspaceId!==current.workspaceId
      ||(!sessions.some(s=>s.sessionId===record.sessionId&&s.evidenceRefs?.includes(ref))&&!observations.some(o=>o.evidenceRefs.includes(ref)));}))return false;
    return true;
  }
  function close(input,view){if(!scope(view,true))return fail('NOT_HOST');const current=owned(input,view);if(!current)return fail('NOT_FOUND');
    if(!['achieved','abandoned'].includes(input.status))return fail('INVALID_STATUS');
    if(input.status==='achieved'&&!achievement(current,input.evidenceRefs))return fail('ACHIEVEMENT_UNPROVEN');
    return changed(store.update(view.workspaceId,current.objectiveId,{status:input.status,
      ...(input.status==='achieved'?{milestones:current.milestones.map(m=>({...m,status:m.status==='dropped'?'dropped':'done'}))}:{})},mutationOptions(input,view)),view.workspaceId);
  }
  function linkSession(workspaceId,objectiveId,sessionId,milestoneId){const session=readSession(sessionId);if(!session||session.workspaceId!==workspaceId||session.origin?.objectiveId!==objectiveId)return fail('SESSION_OUT_OF_SCOPE');return changed(store.linkSession(workspaceId,objectiveId,sessionId,milestoneId),workspaceId);}
  function prepareSpawn(input,context) {
    const current=store.get(context.workspaceId,input.objectiveId);
    if(!current||current.projectAgentConversationId!==context.parentConversationId)return {error:'objective_not_found'};
    if(!scope({workspaceId:context.workspaceId,conversationId:context.parentConversationId},true))return {error:'not_host'};
    if(current.status!=='active'||current.pendingConfirmation)return {error:'objective_paused'};
    if(current.autonomy==='report_only')return {error:'objective_report_only'};
    const view={...context,conversationId:context.parentConversationId};
    if(!input.anchorMessageIds?.some(anchorMessageId=>currentUser({anchorMessageId},view)))return {error:'current_user_required'};
    return {ok:true,objectiveId:current.objectiveId};
  }
  return {create,get,list,update,pause,resume,close,linkSession,prepareSpawn};
}
