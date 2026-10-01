import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import path from 'node:path';
import {validateDelegationInput} from './tool-specs.mjs';
import {pathOf} from '../data-store.mjs';
import {isMemoryWorkspaceId} from '../memory/memory-store.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const objectiveActionCardId=id=>`card:question:objective:${id}`;
/** Device-only authority and reservations. A fact batch freezes one task, before asynchronous creation. */
export function createObjectiveActions({rootDir=null,now=()=>new Date()}={}){
 const stamp=()=>new Date(now()).toISOString();
 function file(ws){if(!isMemoryWorkspaceId(ws))throw Error('INVALID_WORKSPACE');return path.join(rootDir||pathOf('projectRuntime'),ws,'objectives','actions-state.json');}
 function read(ws){try{const raw=JSON.parse(readFileSync(file(ws),'utf8'));if(raw.schemaVersion!==1||!Array.isArray(raw.items)||raw.items.some(item=>!/^action-[a-f0-9]{64}$/.test(item.actionId)||item.workspaceId!==ws||typeof item.objectiveId!=='string'||!Number.isInteger(item.version)||!Number.isFinite(Date.parse(item.createdAt))||!['proposed','reserved','spawned','declined'].includes(item.state)||!item.input||typeof item.input!=='object'||!Array.isArray(item.eventIds)||!item.eventIds.length||item.eventIds.some(id=>typeof id!=='string'||!id||id.length>200)||item.actionId!==`action-${hash([ws,item.objectiveId,item.eventIds.slice().sort()])}`||!validateDelegationInput('spawn_session',item.input).ok||!['auto','proposal'].includes(item.mode)||(item.state!=='proposed'&&!Number.isFinite(Date.parse(item.reservedAt)))))throw Error('CORRUPT_OBJECTIVE_ACTIONS');if(new Set(raw.items.map(item=>item.actionId)).size!==raw.items.length)throw Error('CORRUPT_OBJECTIVE_ACTIONS');return raw;}catch(error){if(error.code==='ENOENT')return {schemaVersion:1,items:[]};throw error;}}
 function save(ws,state){const target=file(ws);mkdirSync(path.dirname(target),{recursive:true});const temp=`${target}.${randomUUID()}.tmp`;writeFileSync(temp,JSON.stringify(state)+'\n');renameSync(temp,target);}
 function usage(ws,id){const day=stamp().slice(0,10);return read(ws).items.filter(item=>item.objectiveId===id&&item.mode==='auto'&&item.reservedAt?.slice(0,10)===day).length;}
 function prepare(objective,input,eventIds,{forceProposal=false}={}){
  const ws=objective.workspaceId,state=read(ws),actionId=`action-${hash([ws,objective.objectiveId,eventIds.slice().sort()])}`;
  let item=state.items.find(item=>item.actionId===actionId);
  if(item){if(item.version!==objective.version&&item.state!=='spawned')return {error:'objective_proposal_stale'};return {ok:true,item:structuredClone(item),replayed:true};}
  if(state.items.filter(item=>item.state==='proposed'&&Date.parse(stamp())-Date.parse(item.createdAt)<=7*86_400_000).length>=128)return {error:'objective_proposal_capacity'};
  const auto=objective.autonomy==='act'&&!forceProposal&&usage(ws,objective.objectiveId)<Math.min(3,objective.budget.maxAutoSessionsPerDay);
  item={actionId,workspaceId:ws,objectiveId:objective.objectiveId,version:objective.version,eventIds:eventIds.slice().sort(),input:structuredClone(input),createdAt:stamp(),mode:auto?'auto':'proposal',state:auto?'reserved':'proposed',...(auto?{reservedAt:stamp()}:{})};
  state.items.push(item);save(ws,state);return {ok:true,item:structuredClone(item)};
 }
 function approve(ws,id,objective,anchor,{decline=false}={}){const state=read(ws),item=state.items.find(row=>row.actionId===id);if(item?.state==='declined')return {error:'objective_proposal_declined'};if(!item||item.objectiveId!==objective.objectiveId||item.version!==objective.version&&item.state!=='spawned'||item.mode!=='proposal'||item.state==='declined'||Date.parse(stamp())-Date.parse(item.createdAt)>7*86_400_000)return {error:'objective_proposal_stale'};
  if(item.state==='proposed'){item.state=decline?'declined':'reserved';item.approvalAnchor=anchor;item.reservedAt=stamp();save(ws,state);}return {ok:!decline,item:structuredClone(item)};
 }
 function link(ws,id,sessionId){const state=read(ws),item=state.items.find(row=>row.actionId===id);if(!item)return false;if(item.sessionId&&item.sessionId!==sessionId)throw Error('OBJECTIVE_ACTION_SESSION_MISMATCH');item.state='spawned';item.sessionId=sessionId;save(ws,state);return true;}
 const list=ws=>structuredClone(read(ws).items);
 return {prepare,approve,link,usage,list,pending:ws=>list(ws).filter(item=>item.state==='proposed'&&Date.parse(stamp())-Date.parse(item.createdAt)<=7*86_400_000),get:(ws,id)=>list(ws).find(item=>item.actionId===id)||null};
}
