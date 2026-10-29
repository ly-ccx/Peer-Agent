import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createObjectiveStore} from './objective-store.mjs';
import {createWatchState} from './watch-state.mjs';
import {createWatchProbeRuntime} from './watch-probe-provider.mjs';
import {createWatchRunner} from './watch-runner.mjs';
function world(extra={}){
 const root=mkdtempSync(path.join(os.tmpdir(),'watch-runner-'));let clock='2026-10-01T09:00:00.000Z',lease=true;
 const store=createObjectiveStore({rootDir:root,now:()=>new Date(clock)}),state=createWatchState({rootDir:root,now:()=>clock}),signals=[];
 writeFileSync(path.join(root,'watched.txt'),'one');
 const item=store.create({workspaceId:'ws',projectAgentConversationId:'c',originMessageId:'u',title:'Watch',outcome:'stable',createdBy:'user_request',autonomy:'report_only',budget:{maxAutoSessionsPerDay:0,maxProbeRunsPerDay:60},
  watches:[{watchId:'watch',kind:'schedule',schedule:{kind:'custom_cron',timezone:'UTC',cron:'* * * * *'},probe:{type:'deterministic',check:'file_hash',spec:{path:'watched.txt'}}}],...extra}).item;
 const canObserve=()=>lease,probeRuntime=createWatchProbeRuntime({resolveObjective:(ws,id)=>store.get(ws,id),resolveWorkspacePath:()=>root,canObserve,now:()=>clock});
 const options={store,state,probeRuntime,canObserve,resolveWorkspacePath:()=>root,emitSignal:event=>signals.push(event),now:()=>clock};
 return {root,store,state,item,signals,options,setClock:value=>clock=value,setLease:value=>lease=value,async cleanup(runner){await runner.dispose();rmSync(root,{recursive:true,force:true});}};
}
test('missed schedules run only the latest once, unchanged checks persist evidence without waking and restart stays idempotent',async()=>{
 const w=world(),runner=createWatchRunner(w.options);
 try{
  w.setClock('2026-10-01T09:05:00.000Z');await runner.reconcile('ws');assert.equal(w.signals.length,1);
  assert.equal(w.store.observations('ws',w.item.objectiveId).length,1);await runner.reconcile('ws');assert.equal(w.store.observations('ws',w.item.objectiveId).length,1);
  w.setClock('2026-10-01T09:06:00.000Z');await runner.reconcile('ws');const rows=w.store.observations('ws',w.item.objectiveId);assert.equal(rows.length,2);assert.equal(rows[1].changed,false);assert.ok(w.state.readEvidence(rows[1].evidenceRefs[0]).execution.grant.granted);assert.equal(w.signals.length,1);
  const restarted=createWatchRunner({...w.options,state:createWatchState({rootDir:w.root,now:()=> '2026-10-01T09:06:00.000Z'})});await restarted.reconcile('ws');assert.equal(w.store.observations('ws',w.item.objectiveId).length,2);await restarted.dispose();
 }finally{await w.cleanup(runner);}
});
test('failure-only watch preserves healthy baseline and only wakes on actual failure; paused and unowned projects do not probe',async()=>{
 const w=world(),runner=createWatchRunner(w.options);
 try{
  w.store.update('ws',w.item.objectiveId,{watches:w.item.watches.map(watch=>({...watch,notificationPolicy:'failure_only'}))});
  w.setClock('2026-10-01T09:01:00.000Z');await runner.reconcile('ws');assert.equal(w.signals.length,0);assert.equal(w.store.observations('ws',w.item.objectiveId).length,1);
  w.store.update('ws',w.item.objectiveId,{status:'paused'});w.setClock('2026-10-01T09:02:00.000Z');await runner.reconcile('ws');assert.equal(w.state.usage('ws',w.item.objectiveId).probes,1);
  w.store.update('ws',w.item.objectiveId,{status:'active'});w.setLease(false);await runner.reconcile('ws');assert.equal(w.state.usage('ws',w.item.objectiveId).probes,1);
 }finally{await w.cleanup(runner);}
});
test('crash after Evidence write repairs the missing observation without rerunning the readonly capability',async()=>{
 const w=world(),runner=createWatchRunner(w.options);let calls=0;
 try{
  const key='pending';w.state.reserve('ws',w.item.objectiveId,key,60);w.state.update('ws',w.item.objectiveId,'watch',{pendingExecutionKey:key,lastScheduledAt:'2026-10-01T09:00:00.000Z'});
  const execution=await w.options.probeRuntime.execute({workspaceId:'ws',objectiveId:w.item.objectiveId,watchId:'watch',executionKey:key});
  w.state.writeEvidence('ws',key,{execution,observation:{objectiveId:w.item.objectiveId,watchId:'watch',observedAt:'2026-10-01T09:00:00.000Z',digest:'real',summary:'actual',severity:'info'}});
  w.options.probeRuntime.execute=async()=>{calls++;throw Error('must not rerun');};await runner.reconcile('ws');assert.equal(calls,0);assert.equal(w.store.observations('ws',w.item.objectiveId).length,1);assert.equal(w.state.get('ws',w.item.objectiveId,'watch').pendingExecutionKey,null);
 }finally{await w.cleanup(runner);}
});

test('pause aborts a real running probe and waits for its actual process exit before releasing the flight',async()=>{
 const {runReadProcess}=await import('./probes/read-process.mjs');const w=world();let started;
 const ready=new Promise(resolve=>started=resolve);
 w.options.probeRuntime={async execute(input){started();const result=await runReadProcess(process.execPath,['-e',"process.on('SIGTERM',()=>setTimeout(()=>process.exit(),30));setInterval(()=>{},10)"],{cwd:w.root,signal:input.signal});
  return {call:{toolCallId:'actual',capabilityId:'local.objective.observe'},grant:{granted:true},result:{status:'cancelled',outputPreview:{observation:{ok:false,unavailableReason:result.reason}}}};}};
 const runner=createWatchRunner(w.options);
 try{w.setClock('2026-10-01T09:01:00.000Z');const pending=runner.reconcile('ws');await ready;assert.equal(runner.activeCount(),1);
  w.store.update('ws',w.item.objectiveId,{status:'paused'});await runner.reconcile('ws');await pending;assert.equal(runner.activeCount(),0);assert.equal(w.signals.length,0);assert.equal(w.store.observations('ws',w.item.objectiveId).length,1);
 }finally{await w.cleanup(runner);}
});
test('file watcher debounces actual changes and ignores dependency trees',async()=>{
 const w=world({watches:[{watchId:'watch',kind:'event',source:{type:'files',paths:['watched.txt'],debounceMs:5000}}]}),runner=createWatchRunner({...w.options,debounceMs:20});
 try{await runner.reconcile('ws');assert.equal(w.signals.length,1);w.setClock('2026-10-01T09:00:06.000Z');writeFileSync(path.join(w.root,'watched.txt'),'two');writeFileSync(path.join(w.root,'watched.txt'),'three');
  const deadline=Date.now()+2000;while(w.signals.length<2&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,25));await runner.reconcile('ws');}assert.equal(w.signals.length,2);assert.equal(w.store.observations('ws',w.item.objectiveId).length,2);
 }finally{await w.cleanup(runner);}
});
test('failed Inbox delivery is retried after restart without repeating the probe or losing the changed fact',async()=>{
 const w=world(),runner=createWatchRunner({...w.options,emitSignal:()=>{throw Error('inbox failed');}});let calls=0;
 try{w.setClock('2026-10-01T09:01:00.000Z');await runner.reconcile('ws');assert.ok(w.state.get('ws',w.item.objectiveId,'watch').pendingSignalExecutionKey);
  w.options.probeRuntime.execute=async()=>{calls++;throw Error('must not run');};const next=createWatchRunner(w.options);await next.reconcile('ws');assert.equal(calls,0);assert.equal(w.signals.length,1);assert.equal(w.store.observations('ws',w.item.objectiveId).length,1);await next.dispose();
 }finally{await w.cleanup(runner);}
});
test('resumed file watches check changes made while paused and do not poll files when idle',async()=>{
 const w=world({watches:[{watchId:'watch',kind:'event',source:{type:'files',paths:['watched.txt'],debounceMs:5000}}]}),runner=createWatchRunner(w.options);
 try{await runner.reconcile('ws');await runner.reconcile('ws');assert.equal(w.store.observations('ws',w.item.objectiveId).length,1);
  w.store.update('ws',w.item.objectiveId,{status:'paused'});await runner.reconcile('ws');writeFileSync(path.join(w.root,'watched.txt'),'paused change');
  w.store.update('ws',w.item.objectiveId,{status:'active'});await runner.reconcile('ws');assert.equal(w.signals.length,2);
  await runner.reconcile('ws');assert.equal(w.store.observations('ws',w.item.objectiveId).length,2);
 }finally{await w.cleanup(runner);}
});
