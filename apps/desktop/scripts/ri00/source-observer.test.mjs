import test from'node:test';import assert from'node:assert/strict';import{EventEmitter}from'node:events';
import fs from'node:fs';import os from'node:os';import path from'node:path';import{observeSourceEpoch}from'./source-observer.mjs';
function fixture(extra={}){let time=0,scans=0,revision=1,metadata='A',owner=1;const handles=[],notices=[];
 const observer=observeSourceEpoch({root:'/source',coordinationDirectory:'/source/project-runtime/target',now:()=>time,
  stat:()=>({dev:1,ino:owner,isDirectory:()=>true,isSymbolicLink:()=>false}),watch:(dir,options,cb)=>{const e=new EventEmitter();e.dir=dir;e.options=options;e.signal=cb;e.closed=false;e.close=()=>e.closed=true;handles.push(e);return e;},
  inventory:()=>{scans++;return {sha256:metadata,entries:[],bytes:0};},readRevision:async()=>revision,onDirty:()=>notices.push(time),...extra});
 return {observer,handles,notices,setTime:t=>time=t,setMetadata:m=>metadata=m,setRevision:r=>revision=r,setOwner:n=>owner=n,scans:()=>scans};}
test('stable heartbeats use cache; periodic audit and forced comparisons refresh inventory and revision',async()=>{
 const f=fixture();try{const first=await f.observer.read();assert.equal(first.stable,true);for(let t=30000;t<600000;t+=30000){f.setTime(t);assert.equal(await f.observer.read(),first);}assert.equal(f.scans(),2);
 f.setTime(600000);assert.equal(f.observer.due(),true);await f.observer.read();assert.equal(f.scans(),4);await f.observer.read({force:true});assert.equal(f.scans(),6);}finally{assert.equal(f.observer.close().liveWatchers,0);}
});
test('canonical events coalesce, lease/sqlite maintenance is ignored, unknown names invalidate and force bypasses debounce',async()=>{
 const f=fixture();try{await f.observer.read();const root=f.handles.find(h=>h.dir.endsWith('/target')),pointer=f.handles.find(h=>h.dir.endsWith('.read-models'));
 root.signal('change','host.lease');pointer.signal('change','coordination-index.sqlite-wal');assert.equal(f.observer.snapshot().events,0);
 f.handles[0].signal('change','plan.json');f.handles[0].signal('change','plan.json');f.setMetadata('B');assert.equal(f.observer.due(),false);assert.equal(f.observer.nextCheckMs(),2000);
 await f.observer.read({force:true});assert.equal(f.scans(),4);assert.equal(f.observer.snapshot().pendingChanges,false);
 pointer.signal('rename',null);f.setTime(2000);assert.equal(f.observer.due(),true);await f.observer.read();assert.equal(f.observer.snapshot().unknownFilenameEvents,1);
 }finally{f.observer.close();}
});
test('events during refresh stay pending; root replacement rebinds owned watchers and changes identity',async()=>{
 let signal;const f=fixture({readRevision:async()=>{if(signal){const call=signal;signal=null;call();}return 1;}});
 try{await f.observer.read();const old=await f.observer.read();signal=()=>f.handles[0].signal('change','x');await f.observer.read({force:true});assert.equal(f.observer.snapshot().pendingChanges,true);
 const prior=f.handles.slice();f.setOwner(2);const next=await f.observer.read({force:true});assert.notEqual(next.sha256,old.sha256);assert.equal(f.observer.snapshot().rootsRebound,6);assert.ok(prior.every(h=>h.closed));
 }finally{f.observer.close();}
});
test('unstable source is explicit; watcher errors/event cap and closed access fail rather than silently trusting cache',async()=>{
 let n=0;const f=fixture({inventory:()=>({sha256:String(n++),entries:[],bytes:0})});assert.equal((await f.observer.read()).stable,false);f.handles[0].emit('error',Object.assign(Error('detail'),{code:'EIO'}));await assert.rejects(f.observer.read(),/watch_error:EIO/);f.observer.close();
 const capped=fixture({maxEvents:1});await capped.observer.read();capped.handles[0].signal('change','a');capped.handles[0].signal('change','b');await assert.rejects(capped.observer.read(),/event_budget/);capped.observer.close();await assert.rejects(capped.observer.read(),/closed/);
});
test('real filesystem canonical notifications invalidate an owned source watch and close all handles',{timeout:10000},async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ri00-source-watch-')),coord=path.join(root,'project-runtime','target');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 for(const d of['goal-plans','conversations','projects'])fs.mkdirSync(path.join(root,d));fs.mkdirSync(path.join(coord,'coordination-v2'),{recursive:true});fs.mkdirSync(path.join(coord,'coordination.jsonl'));fs.mkdirSync(path.join(coord,'.read-models'));
 const file='coordination-00000000-0000-0000-0000-000000000000.sqlite';fs.writeFileSync(path.join(coord,'.read-models',file),'fixture');fs.writeFileSync(path.join(coord,'.read-models','coordination-current.json'),JSON.stringify({schemaVersion:1,file}));
 const observer=observeSourceEpoch({root,coordinationDirectory:coord,readRevision:async()=>1,debounceMs:0});t.after(()=>observer.close());const before=await observer.read();fs.writeFileSync(path.join(root,'projects','project.json'),'{}');
 for(let i=0;i<120&&!observer.snapshot().events;i++)await new Promise(r=>setTimeout(r,30));assert.ok(observer.snapshot().events>0);const after=await observer.read();assert.notEqual(after.sha256,before.sha256);assert.equal(after.stable,true);assert.equal(observer.close().liveWatchers,0);
});

test('a partial rebind close failure retains ownership of both handles and cleanup reports unresolved resources',async()=>{
 const f=fixture();await f.observer.read();let attempts=0;const original=f.handles[0].close;f.handles[0].close=()=>{if(attempts++<2)throw Error('owned close failure');original();};
 f.setOwner(2);await assert.rejects(f.observer.read({force:true}),/rebind_close_failed/);assert.equal(f.observer.snapshot().liveWatchers,7);
 const first=f.observer.close();assert.equal(first.liveWatchers,1);assert.equal(first.closeFailures,1);assert.ok(f.handles.at(-1).closed);assert.equal(f.observer.close().liveWatchers,0);
});
