import {objectiveActionCardId} from './objective-actions.mjs';
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

function affirmativeResume(content,pending){
  const text=cleanUserText(content);
  if(/不要|别|不能|不允许|不同意|不恢复|不确认|不重启|暂不|先不|\b(?:no|not|cannot|never)\b|can['’]t|won['’]t|don['’]?t/i.test(text))return false;
  return (pending?/(?:同意|确认|开始|可以|^好[的啊吧]?\s*$|\byes\b|\bconfirm\b|\bapprove\b|\bstart\b|\bresume\b)/i:/(?:恢复|重启|重新(?:开启|开始)|继续.{0,8}目标|\bresume\b|\brestart\b|\breopen\b|\bcontinue\b.{0,30}\bobjective\b)/i).test(text);
}
function authorizesBudget(content,current,next){
  const text=cleanUserText(content);
  if(/不要|别|不能|不允许|\b(?:no|not|cannot|never)\b|can['’]t|won['’]t|don['’]?t/i.test(text))return false;
  const parts=text.split(/[；;。\n]/);
  const dimensions=[['maxAutoSessionsPerDay',/自动任务|自动会话|auto(?:matic)?[ -]?(?:task|session)/i],['maxProbeRunsPerDay',/探测|巡检|probe|observation/i]];
  return dimensions.every(([key,subject])=>next[key]<=current[key]||parts.some(part=>{
    if(!subject.test(part)||!/(?:提高|增加|上调|放宽|调整).{0,20}(?:到|为)|\b(?:raise|increase|expand|set)\b.{0,60}\bto\b/i.test(part))return false;
    const amount=part.match(/(?:到|为|\bto\b)\s*(\d+)\b/i);
    return amount&&next[key]<=Number(amount[1]);
  }));
}

/** Owns user provenance, objective scope, transitions and factual achievement; no model execution. */
export function createObjectiveService({store,readConversation,resolveConversationId,canManageWorkspace=()=>true,readSession=()=>null,resolveEvidence=()=>null,decorateView=(_ws,item)=>item,actions=null,readSessions=()=>[],onChanged=null}={}) {
  if(!store)throw TypeError('ObjectiveService requires store');
  function scope(view,write=false){return typeof view?.workspaceId==='string'&&(!write||canManageWorkspace(view.workspaceId)===true)&&resolveConversationId(view.workspaceId)===view.conversationId;}
  function currentUser(input,view){
    if(!scope(view,true)||!Array.isArray(view.currentInputAnchors)||!view.currentInputAnchors.includes(input.anchorMessageId))return null;
    return (readConversation(view.conversationId)||[]).find(m=>m.id===input.anchorMessageId&&isCanonicalUserInput(m))||null;
  }
  function owned(input,view){return scope(view)?store.get(view.workspaceId,input.objectiveId):null;}
  function changed(result,workspaceId){if(result.ok&&typeof onChanged==='function')onChanged(workspaceId);return result;}
  function notificationWatches(watches,origin,current=''){
    const onlyFailure=/(?:CI|构建|测试|build|test).{0,15}(?:失败|挂了|fail).{0,8}(?:才|只)|(?:only|just).{0,20}(?:CI|build|test).{0,15}fail/i.test(cleanUserText(origin));
    const allChanges=!/不要|别|不能|\bnot\b|don['’]?t/i.test(cleanUserText(current))&&/(?:所有|任何|全部).{0,8}变化.{0,8}(?:告诉|通知)|notify.{0,20}all.{0,8}changes/i.test(cleanUserText(current));
    return onlyFailure&&!allChanges?(watches || []).map(watch=>({...watch,notificationPolicy:'failure_only'})):watches;
  }
  function create(input,view={}){
    const anchor=currentUser(input,view);if(!anchor)return fail('CURRENT_USER_REQUIRED');
    const createdBy=input.createdBy || 'user_request',autonomy=input.autonomy || 'propose';
    if(createdBy==='user_request'&&!/(?:目标|持续|盯着|监控|每天|定期|一直|直到|发布前|发版前|稳定下来|(?:CI|构建|测试|test|build).{0,10}(?:挂了|失败|fail)|\bgoal\b|\bmonitor\b|\bwatch\b|\bkeep\b)/i.test(cleanUserText(anchor.content)))return fail('OBJECTIVE_NOT_REQUESTED');
    if(createdBy==='user_request'&&!userAuthorizesObjectiveAutonomy(anchor.content,autonomy))return fail('AUTONOMY_NOT_AUTHORIZED');
    if(input.budget&&!authorizesBudget(anchor.content,{maxAutoSessionsPerDay:3,maxProbeRunsPerDay:60},input.budget))return fail('BUDGET_NOT_AUTHORIZED');
    if(input.autoAccept===true&&(createdBy!=='user_request'||!authorizesAutoAccept(anchor.content)))return fail('AUTO_ACCEPT_NOT_AUTHORIZED');
    if(createdBy==='agent_proposal'&&autonomy==='act')return fail('AUTONOMY_NOT_AUTHORIZED');
    if(Array.isArray(input.milestones)&&input.milestones.some(m=>m.sessionIds?.length||m.status==='done'))return fail('SESSION_OUT_OF_SCOPE');
    const requestId=createHash('sha256').update(`${view.conversationId}\0${anchor.id}\0${input.title}\0${input.outcome}`).digest('hex');
    const result=store.create({...input,...(input.watches?{watches:notificationWatches(input.watches,anchor.content)}:{}),workspaceId:view.workspaceId,projectAgentConversationId:view.conversationId,originMessageId:anchor.id,createdBy,autonomy,...(input.autoAccept===true?{autoAcceptApprovedBy:anchor.id}:{}),
      status:createdBy==='agent_proposal'?'paused':'active',pendingConfirmation:createdBy==='agent_proposal'}, {requestId});
    return changed(result,view.workspaceId);
  }
  function get(input,view){const item=owned(input,view);return item?{ok:true,item:decorateView(view.workspaceId,item),observations:store.observations(view.workspaceId,item.objectiveId).slice(-30)}:fail('NOT_FOUND');}
  function list(_input,view){return scope(view)?{ok:true,items:store.list(view.workspaceId).map(item=>decorateView(view.workspaceId,{...item,lastObservation:store.observations(view.workspaceId,item.objectiveId).at(-1)||null}))}:fail('NOT_FOUND');}
  function mutationOptions(input,view){return {expectedVersion:input.expectedVersion??null,requestId:view.commandId||null,fingerprint:view.commandFingerprint||null};}
  function update(input,view){
    if(!scope(view,true))return fail('NOT_HOST');
    const current=owned(input,view);if(!current)return fail('NOT_FOUND');
    if(input.status!==undefined||input.confirmed!==undefined||input.autoAcceptApprovedBy!==undefined||input.pendingConfirmation!==undefined)return fail('HOST_FIELDS_FORBIDDEN');
    const raisesAutonomy=input.autonomy!==undefined&&LEVEL[input.autonomy]>LEVEL[current.autonomy];
    const expandsBudget=input.budget&&(input.budget.maxAutoSessionsPerDay>current.budget.maxAutoSessionsPerDay||input.budget.maxProbeRunsPerDay>current.budget.maxProbeRunsPerDay);
    if(raisesAutonomy||expandsBudget){const anchor=currentUser(input,view);if(!anchor)return fail('CURRENT_USER_REQUIRED');
      if(raisesAutonomy&&!userAuthorizesObjectiveAutonomy(anchor.content,input.autonomy))return fail('AUTONOMY_NOT_AUTHORIZED');
      if(expandsBudget&&!authorizesBudget(anchor.content,current.budget,input.budget))return fail('BUDGET_NOT_AUTHORIZED');}
    if(input.autoAccept===true){const anchor=currentUser(input,view);if(!anchor)return fail('CURRENT_USER_REQUIRED');if(!authorizesAutoAccept(anchor.content))return fail('AUTO_ACCEPT_NOT_AUTHORIZED');}
    const patch={};for(const key of ['autoAccept','title','outcome','watches','milestones','successSignals','autonomy','budget','deadline'])if(input[key]!==undefined)patch[key]=input[key];
    if(input.autoAccept!==undefined)patch.autoAcceptApprovedBy=input.autoAccept?input.anchorMessageId:undefined;
    if(patch.watches){const origin=(readConversation(view.conversationId)||[]).find(m=>m.id===current.originMessageId&&isCanonicalUserInput(m));patch.watches=notificationWatches(patch.watches,origin?.content,currentUser(input,view)?.content);}
    const checked=validateObjectiveDefinition({...current,...patch});if(!checked.ok)return checked;
    if(patch.milestones?.some(m=>m.sessionIds?.some(id=>{const session=readSession(id);return !session||session.workspaceId!==view.workspaceId||session.origin?.objectiveId!==current.objectiveId;})))return fail('SESSION_OUT_OF_SCOPE');
    if(patch.milestones?.some(m=>m.status==='done'&&(!m.sessionIds.length||m.sessionIds.some(id=>readSession(id)?.status!=='accepted'))))return fail('MILESTONE_UNPROVEN');
    return changed(store.update(view.workspaceId,current.objectiveId,patch,mutationOptions(input,view)),view.workspaceId);
  }
  function pause(input,view){if(!scope(view,true))return fail('NOT_HOST');const current=owned(input,view);return current?changed(store.update(view.workspaceId,current.objectiveId,{status:'paused'},mutationOptions(input,view)),view.workspaceId):fail('NOT_FOUND');}
  function resume(input,view){
    const current=owned(input,view);if(!current)return fail('NOT_FOUND');const anchor=currentUser(input,view);if(!anchor)return fail('CURRENT_USER_REQUIRED');
    if(!affirmativeResume(anchor.content,current.pendingConfirmation))return fail('CONFIRMATION_REQUIRED');
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
  function linkSession(workspaceId,objectiveId,sessionId,milestoneId){const session=readSession(sessionId);if(!session||session.workspaceId!==workspaceId||session.origin?.objectiveId!==objectiveId)return fail('SESSION_OUT_OF_SCOPE');if(session.origin.objectiveActionId)actions?.link(workspaceId,session.origin.objectiveActionId,sessionId);return changed(store.linkSession(workspaceId,objectiveId,sessionId,milestoneId),workspaceId);}
  function prepareSpawnInner(input,context) {
    const view={...context,conversationId:context.parentConversationId};
    const users=(context.currentInputAnchors||[]).map(anchorMessageId=>currentUser({anchorMessageId},view)).filter(Boolean);
    const approval=users.find(user=>user.answerTo?.startsWith('card:question:objective:'));
    const proposal=approval&&actions?.get(context.workspaceId,approval.answerTo.slice('card:question:objective:'.length));
    const wakeIds=[...new Set((context.objectiveWakeEvents||[]).filter(event=>event.workspaceId===context.workspaceId&&event.kind==='objective_signal').map(event=>event.objectiveId))];
    const objectiveId=proposal?.objectiveId||input.objectiveId||(!users.length&&wakeIds.length===1?wakeIds[0]:null);
    if(!objectiveId)return {error:'objective_identity_required'};
    if(proposal&&input.objectiveId&&input.objectiveId!==proposal.objectiveId)return {error:'objective_proposal_scope'};
    const current=store.get(context.workspaceId,objectiveId);
    if(!current||current.projectAgentConversationId!==context.parentConversationId)return {error:'objective_not_found'};
    if(!scope(view,true))return {error:'not_host'};
    if(current.status!=='active'||current.pendingConfirmation)return {error:'objective_paused'};
    if(current.autonomy==='report_only')return {error:'objective_report_only'};
    if(proposal){
      const agreed=/^(?:开始|同意|允许|确认|start|approve|yes)[。.!！\s]*$/i.test(cleanUserText(approval.content));
      const approved=actions.approve(context.workspaceId,proposal.actionId,current,approval.id,{decline:!agreed});
      if(!agreed||!approved.ok)return {error:approved.error||'objective_proposal_declined'};
      return {ok:true,input:{...approved.item.input,anchorMessageIds:[approval.id]},objectiveActionId:proposal.actionId};
    }
    if(users.length){if(!input.anchorMessageIds?.some(id=>users.some(user=>user.id===id&&/(?:处理|修复|开始|执行|开任务|直接修|\bstart\b|\bfix\b|\bimplement\b|\bdo\b)/i.test(cleanUserText(user.content))&&!/(?:不要|别|\bnot\b|don['’]?t|cannot|won['’]?t)/i.test(cleanUserText(user.content)))))return {error:'current_user_work_required'};return {ok:true,input:{...input,objectiveId}};}
    if(!actions)return {error:'current_user_required'};
    if(input.supersedes)return {error:'objective_user_confirmation_required'};
    const events=(context.objectiveWakeEvents||[]).filter(event=>event.objectiveId===objectiveId&&event.workspaceId===context.workspaceId&&event.kind==='objective_signal'&&typeof event.eventId==='string'&&event.eventId.length<=200).filter(event=>{
      const observation=store.observations(context.workspaceId,objectiveId).find(row=>row.executionKey===event.executionKey&&row.watchId===event.watchId&&row.changed===true);
      return observation?.evidenceRefs.some(ref=>{const evidence=resolveEvidence(ref);return evidence?.workspaceId===context.workspaceId&&evidence.objectiveId===objectiveId&&evidence.watchId===event.watchId&&evidence.executionKey===event.executionKey&&evidence.execution?.result?.status==='success';});
    });
    if(!events.length)return {error:'objective_observation_unproven'};
    const recent=readSessions(context.workspaceId).filter(row=>row.origin?.objectiveId===objectiveId).sort((a,b)=>Date.parse(b.createdAt||0)-Date.parse(a.createdAt||0)).slice(0,3);
    const prepared=actions.prepare(current,{...input,objectiveId,anchorMessageIds:[current.originMessageId],priority:'low'},events.map(event=>event.eventId),{forceProposal:recent.length===3&&recent.every(row=>row.status==='failed')});
    if(!prepared.ok)return prepared;
    if(prepared.item.state==='proposed'){onChanged?.(context.workspaceId);return {error:'objective_proposal_required',actionId:prepared.item.actionId,cardId:objectiveActionCardId(prepared.item.actionId)};}
    if(prepared.item.state==='spawned'&&!readSession(prepared.item.sessionId))return {error:'objective_action_session_missing'};
    if(prepared.item.state==='declined')return {error:'objective_proposal_declined'};
    return {ok:true,input:prepared.item.input,objectiveActionId:prepared.item.actionId};
  }
  function prepareSpawn(input,context){try{return prepareSpawnInner(input,context);}catch{return {error:'objective_actions_unavailable'};}}
  function consumeAnswers(workspaceId,anchorIds){const view={workspaceId,conversationId:resolveConversationId(workspaceId),currentInputAnchors:anchorIds};for(const anchorMessageId of anchorIds){const user=currentUser({anchorMessageId},view);if(!user?.answerTo?.startsWith('card:question:objective:'))continue;const proposal=actions?.get(workspaceId,user.answerTo.slice('card:question:objective:'.length)),item=proposal&&store.get(workspaceId,proposal.objectiveId);if(!item||item.status!=='active'||item.pendingConfirmation||item.autonomy==='report_only')continue;const agreed=/^(?:开始|同意|允许|确认|start|approve|yes)[。.!！\s]*$/i.test(cleanUserText(user.content));actions.approve(workspaceId,proposal.actionId,item,user.id,{decline:!agreed});onChanged?.(workspaceId);}}
  function acceptancePolicy(workspaceId,objectiveId){const item=store.get(workspaceId,objectiveId),anchor=item?.autoAcceptApprovedBy&&(readConversation(item.projectAgentConversationId)||[]).find(row=>row.id===item.autoAcceptApprovedBy&&isCanonicalUserInput(row));return item?.autoAccept===true&&anchor&&authorizesAutoAccept(anchor.content)?'auto':'confirm';}
  return {create,get,list,update,pause,resume,close,linkSession,prepareSpawn,acceptancePolicy,consumeAnswers};
}
function authorizesAutoAccept(text){const clean=cleanUserText(text);return !/(?:不要|别|不能|\bnot\b|don['’]?t|cannot|won['’]?t)/i.test(clean)&&/(?:允许|同意|可以|开启|启用).{0,12}自动签收|automatically accept|allow.{0,12}auto.{0,5}accept/i.test(clean);}
