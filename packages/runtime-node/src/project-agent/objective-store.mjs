import { validateObjectivePlanFields } from './objective-tool-specs.mjs';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { diffWatchObservation } from '@peer-agent/protocol';
import { pathOf } from '../data-store.mjs';
import { validateAutomationSchedule } from '../automation-schedule.mjs';
import { isMemoryWorkspaceId } from '../memory/memory-store.mjs';

const AUTONOMY = new Set(['report_only','propose','act']);
const STATUSES = new Set(['active','paused','achieved','abandoned']);
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const validId = value => typeof value === 'string' && ID.test(value);
const copy = value => structuredClone(value);
const text = (value,max) => typeof value==='string' && value.trim() && value.length<=max ? value.trim() : null;
const fail = code => ({ok:false,code});

export function validateObjectiveDefinition(raw) {
  if(!raw || !isMemoryWorkspaceId(raw.workspaceId) || !text(raw.projectAgentConversationId,200) || !text(raw.originMessageId,200)
    || !text(raw.title,120) || !text(raw.outcome,2000) || !AUTONOMY.has(raw.autonomy) || !['user_request','agent_proposal'].includes(raw.createdBy)) return fail('INVALID_OBJECTIVE');
  const budget=raw.budget || {maxAutoSessionsPerDay:3,maxProbeRunsPerDay:60};
  if(budget.maxTokensPerDay!==undefined) return fail('TOKEN_BUDGET_UNSUPPORTED');
  if(!Number.isInteger(budget.maxAutoSessionsPerDay)||budget.maxAutoSessionsPerDay<0||budget.maxAutoSessionsPerDay>3
    || !Number.isInteger(budget.maxProbeRunsPerDay)||budget.maxProbeRunsPerDay<1||budget.maxProbeRunsPerDay>1440) return fail('INVALID_BUDGET');
  const planFields=Object.fromEntries(['title','outcome','autonomy','watches','milestones','successSignals','budget','deadline'].filter(key=>raw[key]!==undefined).map(key=>[key,raw[key]]));
  if(!validateObjectivePlanFields(planFields))return fail('INVALID_OBJECTIVE');
  if(raw.deadline!==undefined && (typeof raw.deadline!=='string'||!Number.isFinite(Date.parse(raw.deadline)))) return fail('INVALID_DEADLINE');
  const watches=raw.watches || [], milestones=raw.milestones || [], signals=raw.successSignals || [];
  if(!Array.isArray(watches)||watches.length>16||!Array.isArray(milestones)||milestones.length>32||!Array.isArray(signals)||signals.length>16) return fail('INVALID_OBJECTIVE');
  const ids=new Set();
  for(const watch of watches) {
    if(!validId(watch?.watchId)||ids.has(watch.watchId))return fail('INVALID_WATCH');ids.add(watch.watchId);
    if(watch.kind==='schedule') {try{validateAutomationSchedule(watch.schedule);}catch{return fail('INVALID_SCHEDULE');}}
    else if(watch.kind==='event') {
      const source=watch.source;
      if(!source||!['task_event','git','files'].includes(source.type))return fail('INVALID_WATCH');
      if(source.type==='task_event'&&!['failed','ended','verified'].includes(source.filter))return fail('INVALID_WATCH');
      if(source.type==='git'&&(!text(source.ref,200)||!['new_commits','new_tag'].includes(source.on)))return fail('INVALID_WATCH');
      if(source.type==='files'&&(!Array.isArray(source.paths)||!source.paths.length||source.paths.length>16||source.paths.some(p=>!safeRelative(p))||(source.debounceMs!==undefined&&source.debounceMs!==5000)))return fail('INVALID_WATCH');
    } else return fail('INVALID_WATCH');
    if(watch.kind==='schedule'&&!watch.probe)return fail('INVALID_PROBE');
    if(watch.probe&&!validProbe(watch.probe))return fail('INVALID_PROBE');
  }
  const milestoneIds=new Set();
  for(const milestone of milestones) {
    if(!validId(milestone?.id)||milestoneIds.has(milestone.id)||!text(milestone.title,200)||!['pending','active','done','dropped'].includes(milestone.status)
      ||!Array.isArray(milestone.sessionIds)||milestone.sessionIds.length>100||milestone.sessionIds.some(id=>!validId(id)))return fail('INVALID_MILESTONE');
    milestoneIds.add(milestone.id);
  }
  const signalIds=new Set();
  for(const signal of signals) {
    if(!validId(signal?.signalId)||signalIds.has(signal.signalId)||!ids.has(signal.watchId)||!['equals','contains','succeeded'].includes(signal.operator)
      ||(signal.operator!=='succeeded'&&!text(signal.value,500)))return fail('INVALID_SIGNAL');
    signalIds.add(signal.signalId);
  }
  if(raw.status!==undefined&&!STATUSES.has(raw.status))return fail('INVALID_STATUS');
  return {ok:true,value:{workspaceId:raw.workspaceId,projectAgentConversationId:raw.projectAgentConversationId,originMessageId:raw.originMessageId,
    title:raw.title.trim(),outcome:raw.outcome.trim(),autonomy:raw.autonomy,createdBy:raw.createdBy,watches:copy(watches),milestones:copy(milestones),successSignals:copy(signals),
    budget:{maxAutoSessionsPerDay:budget.maxAutoSessionsPerDay,maxProbeRunsPerDay:budget.maxProbeRunsPerDay},...(raw.deadline?{deadline:new Date(raw.deadline).toISOString()}:{}),
    status:raw.status || (raw.createdBy==='agent_proposal'?'paused':'active'),...(raw.pendingConfirmation===true?{pendingConfirmation:true}:{})}};
}

function safeRelative(value){return !!text(value,500)&&!path.isAbsolute(value)&&!value.includes('\\')&&!value.split('/').includes('..')&&!value.startsWith('-');}
function validProbe(probe){
  if(probe.type==='agent')return !!text(probe.question,1000);
  if(probe.type!=='deterministic'||!['git_ref','file_hash','command'].includes(probe.check)||!probe.spec||typeof probe.spec!=='object'||Array.isArray(probe.spec))return false;
  if(probe.check==='file_hash')return safeRelative(probe.spec.path);
  if(probe.check==='git_ref')return !!text(probe.spec.ref,200)&&!probe.spec.ref.startsWith('-');
  return probe.spec.command==='gh_run_list'&&(!probe.spec.workflow||!!text(probe.spec.workflow,200));
}

/** Portable definitions and append-only observations. Execution/authorization stay in ObjectiveService. */
export function createObjectiveStore({rootDir=null,now=()=>new Date()}={}) {
  function directory(workspaceId){if(!isMemoryWorkspaceId(workspaceId))throw Error('INVALID_WORKSPACE');return path.join(rootDir?path.join(rootDir,'projects'):pathOf('projects'),workspaceId,'objectives');}
  function read(workspaceId){
    try {const raw=JSON.parse(readFileSync(path.join(directory(workspaceId),'objectives.json'),'utf8'));
      if(!raw||raw.schemaVersion!==1||!Array.isArray(raw.items)||raw.items.some(item=>!validateObjectiveDefinition(item).ok||item.workspaceId!==workspaceId||!validId(item.objectiveId)||!Number.isInteger(item.version)||item.version<1||!Number.isFinite(Date.parse(item.createdAt))||!Number.isFinite(Date.parse(item.updatedAt)))||new Set(raw.items.map(item=>item.objectiveId)).size!==raw.items.length)throw Error('CORRUPT_OBJECTIVES');return raw;
    }catch(error){if(error.code==='ENOENT')return {schemaVersion:1,items:[],requests:{}};throw error;}
  }
  function save(workspaceId,state){const dir=directory(workspaceId);mkdirSync(dir,{recursive:true});const file=path.join(dir,'objectives.json'),temp=`${file}.${randomUUID()}.tmp`;writeFileSync(temp,JSON.stringify(state)+'\n');renameSync(temp,file);}
  function list(workspaceId){return copy(read(workspaceId).items);}
  function get(workspaceId,id){return list(workspaceId).find(item=>item.objectiveId===id)||null;}
  function create(input,{requestId=null}={}) {
    const checked=validateObjectiveDefinition(input);if(!checked.ok)return checked;
    const state=read(input.workspaceId);
    if(requestId&&Object.hasOwn(state.requests || {},requestId))return {ok:true,item:copy(state.items.find(item=>item.objectiveId===state.requests[requestId])),replayed:true};
    const at=now().toISOString(),item={...checked.value,objectiveId:`objective-${randomUUID()}`,createdAt:at,updatedAt:at,version:1};
    state.items.push(item);if(requestId)state.requests={...state.requests,[requestId]:item.objectiveId};save(input.workspaceId,state);return {ok:true,item:copy(item)};
  }
  function update(workspaceId,id,patch,{expectedVersion=null,requestId=null,fingerprint=null}={}) {
    const state=read(workspaceId),index=state.items.findIndex(item=>item.objectiveId===id);if(index<0)return fail('NOT_FOUND');
    if(requestId&&Object.hasOwn(state.commands || {},requestId)){const saved=state.commands[requestId];return saved.fingerprint===fingerprint?{ok:true,item:copy(saved.item),replayed:true}:fail('REQUEST_ID_REUSED');}
    const current=state.items[index];if(expectedVersion!==null&&current.version!==expectedVersion)return fail('VERSION_CONFLICT');
    const checked=validateObjectiveDefinition({...current,...patch,workspaceId,projectAgentConversationId:current.projectAgentConversationId,originMessageId:current.originMessageId,createdBy:current.createdBy});if(!checked.ok)return checked;
    const item={...checked.value,objectiveId:id,createdAt:current.createdAt,updatedAt:now().toISOString(),version:current.version+1};
    state.items[index]=item;if(requestId)state.commands={...state.commands,[requestId]:{fingerprint,item:copy(item)}};save(workspaceId,state);return {ok:true,item:copy(item)};
  }
  function observations(workspaceId,objectiveId){
    if(!get(workspaceId,objectiveId))return [];
    let raw;try{raw=readFileSync(path.join(directory(workspaceId),'observations.jsonl'),'utf8');}catch(error){if(error.code==='ENOENT')return [];throw error;}
    return raw.split('\n').filter(Boolean).flatMap(line=>{try{const item=JSON.parse(line);return item.objectiveId===objectiveId?[item]:[];}catch{return [];}});
  }
  function appendObservation(workspaceId,input,{executionKey}={}) {
    const objective=get(workspaceId,input?.objectiveId);if(!objective||!objective.watches.some(w=>w.watchId===input.watchId))return fail('NOT_FOUND');
    if(!text(executionKey,500)||!text(input.digest,128)||!text(input.summary,2000)||!Number.isFinite(Date.parse(input.observedAt))||!Array.isArray(input.evidenceRefs)||!input.evidenceRefs.length
      ||input.evidenceRefs.length>32||input.evidenceRefs.some(ref=>!text(ref,500))||!['info','notable','urgent'].includes(input.severity))return fail('INVALID_OBSERVATION');
    const rows=observations(workspaceId,input.objectiveId),previous=rows.find(row=>row.executionKey===executionKey);
    if(previous)return {ok:true,item:copy(previous),replayed:true};
    const prior=rows.filter(row=>row.watchId===input.watchId).at(-1);
    const item={...diffWatchObservation(prior,input),executionKey,...(typeof input.succeeded==='boolean'?{succeeded:input.succeeded}:{}),...(typeof input.value==='string'?{value:input.value.slice(0,2000)}:{})};
    const dir=directory(workspaceId);mkdirSync(dir,{recursive:true});appendFileSync(path.join(dir,'observations.jsonl'),JSON.stringify(item)+'\n');return {ok:true,item:copy(item)};
  }
  function linkSession(workspaceId,id,sessionId,milestoneId=null){
    const objective=get(workspaceId,id);if(!objective||!validId(sessionId))return fail('NOT_FOUND');
    const milestones=copy(objective.milestones);let milestone=milestoneId?milestones.find(m=>m.id===milestoneId):milestones[0];
    if(!milestone){if(milestoneId)return fail('INVALID_MILESTONE');milestone={id:'work',title:objective.title,status:'active',sessionIds:[]};milestones.push(milestone);}
    if(!milestone.sessionIds.includes(sessionId))milestone.sessionIds.push(sessionId);return update(workspaceId,id,{milestones});
  }
  return {create,update,list,get,observations,appendObservation,linkSession};
}
