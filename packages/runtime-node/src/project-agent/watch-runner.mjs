import {createHash,randomUUID} from 'node:crypto';
import {watch as fsWatch,statSync} from 'node:fs';
import path from 'node:path';
import {inspectSchedule} from '../scheduler-kernel.mjs';
import {expandWatchPaths,matchesWatchPath} from './probes/file-probe.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const identity=(objectiveId,watchId)=>`${objectiveId}:${watchId}`;
const definition=watch=>hash(JSON.stringify(watch));

/** Reconciles owned declarations with device cursors. Probes and factual delivery each have a durable execution identity. */
export function createWatchRunner({store,state,probeRuntime,canObserve,canRegister=canObserve,resolveWorkspacePath,emitSignal=()=>{},onObserved=()=>{},now=()=>new Date().toISOString(),pollMs=60_000,debounceMs=5000,setTimer=setTimeout,clearTimer=clearTimeout,onError=()=>{}}={}){
 const flights=new Map(),listeners=new Map(),dirty=new Map();let timer=null,disposed=false;
 function owned(workspaceId){return !disposed&&canObserve(workspaceId)===true;}
 function runtimeView(workspaceId,item){return {...item,watches:item.watches.map(watch=>({...watch,...state.get(workspaceId,item.objectiveId,watch.watchId)})),usage:{...state.usage(workspaceId,item.objectiveId),autoSessions:0}};}
 function signalAllowed(item,watch,observation){return item.status==='active'&&!item.pendingConfirmation&&observation.changed
   &&!(watch.kind==='event'&&watch.source.type==='task_event'&&observation.value==='[]')
   &&(watch.notificationPolicy!=='failure_only'||observation.succeeded===false&&observation.severity==='urgent');}
 async function persist(workspaceId,item,watch,executionKey,execution){
  const observed=execution.result?.outputPreview?.observation || {ok:false,unavailableReason:'probe_failed'};
  const observation={objectiveId:item.objectiveId,watchId:watch.watchId,observedAt:now(),digest:observed.digest || hash(`unavailable:${observed.unavailableReason || 'probe_failed'}`),
   summary:observed.summary || observed.unavailableReason || 'probe_failed',severity:observed.severity || 'info',...(typeof observed.succeeded==='boolean'?{succeeded:observed.succeeded}:{}),...(typeof observed.value==='string'?{value:observed.value}:{})};
  const evidenceRef=state.writeEvidence(workspaceId,executionKey,{objectiveId:item.objectiveId,watchId:watch.watchId,execution,observation});
  return flush(workspaceId,item,watch,executionKey,{...observation,evidenceRefs:[evidenceRef]},observed.unavailableReason || null);
 }
 async function flush(workspaceId,item,watch,executionKey,observation,unavailableReason){
  const result=store.appendObservation(workspaceId,observation,{executionKey});if(!result.ok)throw Error(result.code);
  state.complete(workspaceId,executionKey);
  const latest=store.get(workspaceId,item.objectiveId),prior=state.get(workspaceId,item.objectiveId,watch.watchId);
  const deliver=latest&&!unavailableReason&&signalAllowed(latest,watch,result.item)&&prior.lastSignalExecutionKey!==executionKey;
  state.update(workspaceId,item.objectiveId,watch.watchId,{lastObservationAt:result.item.observedAt,lastDigest:result.item.digest,unavailableReason,pendingExecutionKey:null,pendingSignalExecutionKey:deliver?executionKey:null});
  if(owned(workspaceId)&&deliver){
   await emitSignal({workspaceId,objectiveId:item.objectiveId,watchId:watch.watchId,executionKey,observation:result.item});
   state.update(workspaceId,item.objectiveId,watch.watchId,{lastSignalExecutionKey:executionKey,pendingSignalExecutionKey:null});
  }
  onObserved({workspaceId,objectiveId:item.objectiveId,observation:result.item});
  return result.item;
 }
 async function probe(workspaceId,item,watch,scheduledAt){
  const key=`${workspaceId}:${identity(item.objectiveId,watch.watchId)}`,config=definition(watch),prior=state.get(workspaceId,item.objectiveId,watch.watchId);
  if(flights.has(key))return {skipped:'overlap'};
  const executionKey=prior.pendingExecutionKey || prior.pendingSignalExecutionKey || `objective-watch:${item.objectiveId}:${watch.watchId}:${config}:${scheduledAt}${watch.kind==='event'&&watch.source.type==='files'?`:${randomUUID()}`:''}`;
  const reservation=state.reserve(workspaceId,item.objectiveId,executionKey,item.budget.maxProbeRunsPerDay);
  if(!reservation.ok){state.update(workspaceId,item.objectiveId,watch.watchId,{unavailableReason:reservation.reason});return {skipped:reservation.reason};}
  const controller=new AbortController();
  const operation=Promise.resolve().then(async()=>{
   const evidence=state.readEvidence(state.evidenceRef(workspaceId,executionKey));
   if(evidence)return flush(workspaceId,item,watch,executionKey,{...evidence.observation,evidenceRefs:[evidence.evidenceRef]},evidence.execution?.result?.outputPreview?.observation?.unavailableReason || null);
   if(reservation.replayed)throw Error('probe_evidence_missing');
   state.update(workspaceId,item.objectiveId,watch.watchId,{definitionHash:config,lastScheduledAt:scheduledAt,pendingExecutionKey:executionKey});
   const execution=await probeRuntime.execute({workspaceId,objectiveId:item.objectiveId,watchId:watch.watchId,executionKey,signal:controller.signal});
   return persist(workspaceId,item,watch,executionKey,execution);
  }).catch(error=>{state.update(workspaceId,item.objectiveId,watch.watchId,{unavailableReason:error.message || 'probe_failed'});onError({workspaceId,objectiveId:item.objectiveId,watchId:watch.watchId,error});return {error:error.message};}).finally(()=>flights.delete(key));
  flights.set(key,{workspaceId,objectiveId:item.objectiveId,watchId:watch.watchId,definitionHash:config,controller,operation});return operation;
 }
 function closeListeners(workspaceId,keep=new Set()){
  for(const [key,binding]of listeners)if(binding.workspaceId===workspaceId&&!keep.has(key)){binding.watchers.forEach(w=>w.close());listeners.delete(key);const pending=dirty.get(key);if(pending?.timer)clearTimer(pending.timer);dirty.delete(key);}
 }
 function listenFiles(workspaceId,item,watch,{baseline=true}={}){
  const key=`${workspaceId}:${identity(item.objectiveId,watch.watchId)}`,config=definition(watch);
  if(listeners.get(key)?.definitionHash===config)return;
  const old=listeners.get(key);old?.watchers.forEach(w=>w.close());listeners.delete(key);
  const paths=expandWatchPaths(resolveWorkspacePath(workspaceId),watch.source.paths),watchers=[];
  const changed=()=>{if(!owned(workspaceId))return;const prior=dirty.get(key);if(prior?.timer)clearTimer(prior.timer);
   const entry={at:now(),timer:setTimer(()=>{entry.timer=null;entry.ready=true;},debounceMs),ready:false};entry.timer?.unref?.();dirty.set(key,entry);};
  try{for(const directory of paths.directories){const watcher=fsWatch(directory,{persistent:false},(_event,name)=>{if(!name)return;const target=path.join(directory,String(name)),relative=path.relative(paths.root,target).split(path.sep).join('/');
      if(matchesWatchPath(relative,watch.source.paths))changed();else if(watch.source.paths.some(pattern=>pattern.includes('**'))){try{if(statSync(target).isDirectory()&&!/(?:^|\/)(?:\.git|node_modules|dist|build|out|target|\.next)(?:\/|$)/.test(relative))changed();}catch{}}});watcher.on('error',()=>changed());watchers.push(watcher);}}
  catch(error){watchers.forEach(w=>w.close());throw error;}
  listeners.set(key,{workspaceId,definitionHash:config,watchers});
  if(baseline&&!dirty.has(key))dirty.set(key,{at:now(),ready:true,timer:null});
 }
 async function reconcile(workspaceId,{run=true}={}){
  if(disposed||(run?!owned(workspaceId):canRegister(workspaceId)!==true)){await stopWorkspace(workspaceId);return [];}
  const items=store.list(workspaceId).filter(item=>item.status==='active'&&!item.pendingConfirmation),live=new Map(),keep=new Set();
  for(const item of items)for(const watch of item.watches){const key=`${workspaceId}:${identity(item.objectiveId,watch.watchId)}`;live.set(key,{item,watch});if(watch.kind==='event'&&watch.source.type==='files')keep.add(key);}
  const stopped=[];for(const [key,flight]of flights)if(flight.workspaceId===workspaceId&&(!live.has(key)||definition(live.get(key).watch)!==flight.definitionHash)){flight.controller.abort();stopped.push(flight.operation);}
  await Promise.allSettled(stopped);closeListeners(workspaceId,keep);
  const checks=[];
  for(const [key,{item,watch}]of live){
   try{
    let facts=state.get(workspaceId,item.objectiveId,watch.watchId);const config=definition(watch);
    if(facts.definitionHash&&facts.definitionHash!==config){state.update(workspaceId,item.objectiveId,watch.watchId,{definitionHash:config,lastScheduledAt:null,nextRunAt:null,pendingExecutionKey:null,pendingSignalExecutionKey:null,lastSignalExecutionKey:null});facts=state.get(workspaceId,item.objectiveId,watch.watchId);}
    if(watch.kind==='event'&&watch.source.type==='files')listenFiles(workspaceId,item,watch);
    const at=now();let scheduledAt=null;
    if(facts.pendingSignalExecutionKey)scheduledAt=facts.lastScheduledAt || at;
    else if(watch.kind==='schedule'){
     const schedule=inspectSchedule({schedule:watch.schedule,after:facts.lastScheduledAt || item.createdAt,now:at,active:flights.has(key)});
     state.update(workspaceId,item.objectiveId,watch.watchId,{nextRunAt:schedule.next});
     if(schedule.skippedReason&&schedule.due)state.update(workspaceId,item.objectiveId,watch.watchId,{lastScheduledAt:schedule.due});
     else scheduledAt=facts.pendingExecutionKey?(facts.lastScheduledAt || at):schedule.due;
    }else if(facts.pendingExecutionKey)scheduledAt=facts.lastScheduledAt || at;
    else if(watch.source.type==='files'){
     const event=dirty.get(key);if(!facts.lastScheduledAt||event?.ready){scheduledAt=event?.at || at;if(run&&event?.ready){dirty.delete(key);const binding=listeners.get(key);binding?.watchers.forEach(w=>w.close());listeners.delete(key);listenFiles(workspaceId,item,watch,{baseline:false});}}
    }else if(!facts.lastScheduledAt||Date.parse(at)-Date.parse(facts.lastScheduledAt)>=pollMs)scheduledAt=new Date(Math.floor(Date.parse(at)/pollMs)*pollMs).toISOString();
    if(run&&scheduledAt)checks.push(probe(workspaceId,item,watch,scheduledAt));
   }catch(error){state.update(workspaceId,item.objectiveId,watch.watchId,{unavailableReason:error.message || 'watch_unavailable'});onError({workspaceId,objectiveId:item.objectiveId,watchId:watch.watchId,error});}
  }
  return Promise.all(checks);
 }
 async function stopWorkspace(workspaceId){closeListeners(workspaceId);const stopped=[];for(const flight of flights.values())if(flight.workspaceId===workspaceId){flight.controller.abort();stopped.push(flight.operation);}await Promise.allSettled(stopped);}
 function start(listWorkspaces){if(timer||disposed)return;const tick=async()=>{try{await Promise.allSettled(listWorkspaces().map(workspaceId=>reconcile(workspaceId).catch(error=>onError({workspaceId,error}))));}catch(error){onError({error});}finally{if(!disposed){timer=setTimer(tick,Math.min(pollMs,1000));timer?.unref?.();}}};timer=setTimer(tick,1);timer?.unref?.();}
 async function dispose(){disposed=true;if(timer)clearTimer(timer);timer=null;await Promise.allSettled([...new Set([...flights.values(),...listeners.values()].map(item=>item.workspaceId))].map(stopWorkspace));}
 return {reconcile,stopWorkspace,start,dispose,runtimeView,activeCount:()=>flights.size};
}
