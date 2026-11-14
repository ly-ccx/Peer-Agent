import fs from'node:fs';import path from'node:path';import{createHash}from'node:crypto';
import{sourceInventory}from'./source-archive.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Notifications invalidate a cache; only a fresh inventory/revision owns source identity. */
export function observeSourceEpoch({root,coordinationDirectory,readRevision,onDirty=()=>{},now=()=>performance.now(),
  inventory=sourceInventory,watch=(...a)=>fs.watch(...a),stat=p=>fs.lstatSync(p),auditMs=600000,debounceMs=2000,maxEvents=100000}){
 if(typeof readRevision!=='function'||![auditMs,debounceMs,maxEvents].every(Number.isFinite)||auditMs<1||debounceMs<0||maxEvents<1)throw Error('bounded_source_observer_required');
 const roots=[...['goal-plans','conversations','projects'].map(label=>({label,dir:path.join(root,label),recursive:true})),
  {label:'coordination-canonical',dir:path.join(coordinationDirectory,'coordination-v2'),recursive:true},
  {label:'coordination-owner',dir:coordinationDirectory,recursive:false,accept:n=>['coordination-fence.json','coordination-recovery.json','coordination.jsonl','coordination-v2','.read-models'].includes(n)},
  {label:'coordination-pointer',dir:path.join(coordinationDirectory,'.read-models'),recursive:false,accept:n=>n==='coordination-current.json'}];
 let closed=false,failed=null,serial=0,consumed=-1,lastRefresh=-Infinity,cache;
 const ownedHandles=new Set();
 const state={closeFailures:0,events:0,ignoredEvents:0,unknownFilenameEvents:0,refreshes:0,cacheHits:0,rootsRebound:0,firstDirtyMs:null,lastDirtyMs:null};
 const fail=reason=>{if(!closed&&!failed){failed=reason;try{onDirty();}catch{}}};
 const healthy=()=>{if(closed)throw Error('source_observer_closed');if(failed)throw Error(failed);};
 const signal=(entry,filename)=>{
  if(closed||failed)return;const name=filename==null?null:String(filename);
  if(name!==null&&entry.accept&&!entry.accept(name)){state.ignoredEvents++;return;}
  state.events++;if(name===null)state.unknownFilenameEvents++;
  if(state.events>maxEvents){fail('source_observer_event_budget');return;}
  serial++;if(state.firstDirtyMs===null)state.firstDirtyMs=now();state.lastDirtyMs=now();
  try{onDirty();}catch{fail('source_observer_notification_failed');}
 };
 function bindings(){
  const owners=[];
  for(const entry of roots){const s=stat(entry.dir);if(!s.isDirectory()||s.isSymbolicLink?.())throw Error('source_observer_root_unavailable');const owner=String(s.dev)+':'+String(s.ino);
   if(entry.owner!==owner){const next=watch(entry.dir,{recursive:entry.recursive},(_event,filename)=>signal(entry,filename));ownedHandles.add(next);next.on('error',e=>fail('source_observer_watch_error:'+(e.code||'unknown')));next.unref?.();
    if(entry.handle){try{entry.handle.close();ownedHandles.delete(entry.handle);}catch{fail('source_observer_rebind_close_failed');throw Error('source_observer_rebind_close_failed');}state.rootsRebound++;serial++;}entry.handle=next;entry.owner=owner;
   }owners.push([entry.label,owner]);
  }return hash(owners);
 }
 const api={
  due(){return !cache||failed!==null||serial!==consumed&&now()-lastRefresh>=debounceMs||now()-lastRefresh>=auditMs;},
  nextCheckMs(){if(!cache||failed)return 0;return Math.max(0,Math.min(auditMs-(now()-lastRefresh),serial!==consumed?debounceMs-(now()-lastRefresh):Infinity));},
  async read({force=false}={}){
   healthy();if(!force&&!api.due()){state.cacheHits++;return cache;}
   const atSerial=serial,ownersBefore=bindings(),before=inventory(root,coordinationDirectory),revisionBefore=await readRevision();healthy();
   const after=inventory(root,coordinationDirectory),revision=await readRevision(),ownersAfter=bindings();healthy();
   if(![revisionBefore,revision].every(v=>Number.isSafeInteger(v)&&v>=0))throw Error('source_observer_revision_required');
   const stable=before.sha256===after.sha256&&revisionBefore===revision&&ownersBefore===ownersAfter;
   cache={...after,metadataSha256:after.sha256,coordinationRevision:revision,rootIdentitySha256:ownersAfter,stable,
    sha256:hash(stable?[after.sha256,revision,ownersAfter]:['unstable',before.sha256,revisionBefore,after.sha256,revision,ownersBefore,ownersAfter])};
   consumed=atSerial;lastRefresh=now();state.refreshes++;if(serial===consumed)state.firstDirtyMs=null;return cache;
  },
  snapshot(){return {...state,failed,closed,pendingChanges:serial!==consumed,liveWatchers:ownedHandles.size};},
  close(){closed=true;for(const handle of ownedHandles){try{handle.close();ownedHandles.delete(handle);}catch{state.closeFailures++;failed??='source_observer_close_failed';}}return api.snapshot();}
 };
 try{bindings();}catch(error){api.close();throw error;}return api;
}
