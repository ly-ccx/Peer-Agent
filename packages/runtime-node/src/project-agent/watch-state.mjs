import { randomUUID,createHash } from 'node:crypto';
import { mkdirSync,readFileSync,writeFileSync,renameSync } from 'node:fs';
import path from 'node:path';
import { isMemoryWorkspaceId } from '../memory/memory-store.mjs';
import { pathOf } from '../data-store.mjs';
const record=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value);
const hash=value=>createHash('sha256').update(value).digest('hex');

/** Device-local scheduling and reservations. Synchronous transactions hold budget before an async probe starts. */
export function createWatchState({rootDir=null,now=()=>new Date().toISOString()}={}) {
 function dir(workspaceId){if(!isMemoryWorkspaceId(workspaceId))throw Error('invalid_workspace');return path.join(rootDir || pathOf('projectRuntime'),workspaceId,'objectives');}
 function read(workspaceId){try{const state=JSON.parse(readFileSync(path.join(dir(workspaceId),'watch-state.json'),'utf8'));
   if(!record(state)||state.schemaVersion!==1||!record(state.watches)||!record(state.reservations)
    ||Object.entries(state.watches).some(([key,value])=>!/^[a-f0-9]{64}$/.test(key)||!record(value))
    ||Object.entries(state.reservations).some(([key,value])=>!record(value)||!validId(value.objectiveId)||typeof value.executionKey!=='string'||hash(value.executionKey)!==key
      ||typeof value.at!=='string'||!Number.isFinite(Date.parse(value.at))||!['reserved','completed'].includes(value.status)))throw Error('watch_state_corrupt');return state;
  }catch(error){if(error.code==='ENOENT')return {schemaVersion:1,watches:{},reservations:{}};throw error;}}
 function save(workspaceId,state){const directory=dir(workspaceId);mkdirSync(directory,{recursive:true});const file=path.join(directory,'watch-state.json'),temp=`${file}.${randomUUID()}.tmp`;writeFileSync(temp,JSON.stringify(state)+'\n');renameSync(temp,file);}
 function get(workspaceId,objectiveId,watchId){return structuredClone(read(workspaceId).watches[hash(`${objectiveId}:${watchId}`)] || {});}
 function update(workspaceId,objectiveId,watchId,patch){const state=read(workspaceId),key=hash(`${objectiveId}:${watchId}`);state.watches[key]={...(state.watches[key] || {}),...patch};save(workspaceId,state);return structuredClone(state.watches[key]);}
 function reserve(workspaceId,objectiveId,executionKey,maxProbeRunsPerDay){
  if(!validId(objectiveId)||typeof executionKey!=='string'||!executionKey||executionKey.length>500||!Number.isInteger(maxProbeRunsPerDay)||maxProbeRunsPerDay<1||maxProbeRunsPerDay>1440)throw Error('invalid_probe_reservation');
  const state=read(workspaceId),key=hash(executionKey),at=now(),existing=state.reservations[key];
  if(existing&&existing.objectiveId!==objectiveId)throw Error('probe_reservation_scope');
  if(existing)return {ok:true,replayed:existing.status==='completed',reservation:structuredClone(existing)};
  const time=Date.parse(at);if(!Number.isFinite(time))throw Error('invalid_clock');
  const reservations=Object.values(state.reservations);const daily=reservations.filter(item=>item.objectiveId===objectiveId&&item.at.slice(0,10)===at.slice(0,10));
  const hourly=reservations.filter(item=>Date.parse(item.at)>time-60*60*1000);
  if(daily.length>=maxProbeRunsPerDay)return {ok:false,reason:'daily_probe_budget'};
  if(hourly.length>=60)return {ok:false,reason:'hourly_probe_budget'};
  const reservation={objectiveId,executionKey,at,status:'reserved'};state.reservations[key]=reservation;
  state.reservations=Object.fromEntries(Object.entries(state.reservations).filter(([,item])=>Date.parse(item.at)>time-7*24*60*60*1000));
  save(workspaceId,state);return {ok:true,reservation};
 }
 function complete(workspaceId,executionKey){const state=read(workspaceId),key=hash(executionKey);if(!state.reservations[key])throw Error('probe_not_reserved');state.reservations[key].status='completed';save(workspaceId,state);}
 function usage(workspaceId,objectiveId){const at=now();return {date:at.slice(0,10),probes:Object.values(read(workspaceId).reservations).filter(item=>item.objectiveId===objectiveId&&item.at.slice(0,10)===at.slice(0,10)).length};}
 function evidenceRef(workspaceId,executionKey){return `objective-probe:${workspaceId}:${hash(executionKey)}`;}
 function evidenceFile(ref){const match=/^objective-probe:([A-Za-z0-9][A-Za-z0-9_.:-]{0,127}):([a-f0-9]{64})$/.exec(ref || '');return match?path.join(dir(match[1]),'probe-evidence',`${match[2]}.json`):null;}
 function writeEvidence(workspaceId,executionKey,record){const ref=evidenceRef(workspaceId,executionKey),file=evidenceFile(ref);if(readEvidence(ref))return ref;mkdirSync(path.dirname(file),{recursive:true});const temp=`${file}.${randomUUID()}.tmp`;
  const item={...record,workspaceId,executionKey,evidenceRef:ref};writeFileSync(temp,JSON.stringify(item)+'\n');renameSync(temp,file);return ref;}
 function readEvidence(ref){const file=evidenceFile(ref);if(!file)return null;try{const item=JSON.parse(readFileSync(file,'utf8'));if(item.evidenceRef!==ref||evidenceRef(item.workspaceId,item.executionKey)!==ref)throw Error('probe_evidence_corrupt');return item;}catch(error){if(error.code==='ENOENT')return null;throw error;}}
 return {get,update,reserve,complete,usage,evidenceRef,writeEvidence,readEvidence};
}
