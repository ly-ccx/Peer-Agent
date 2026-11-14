import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import os from'node:os';import path from'node:path';
import{createDenseResidualProbe}from'./dense-residual-probe.mjs';import{createReadTicketQueue}from'./read-ticket-queue.mjs';
import{e3InstallerSource}from'./e3-install.mjs';
const turn=()=>new Promise(r=>setImmediate(r));
function fixture(t,{list,ttl=5000,allowExposure=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ri00-e3-unit-'));fs.writeFileSync(path.join(dir,'evidence-index.jsonl'),'{}\n');
 const data=[{}],value=[{}],seen=[],store={getStoreDir:()=>dir,listEvidenceIndex(){seen.push('index');return data;}};
 const host={list(input){seen.push('list');if(list)return list.call(this,input,store,value);for(let i=0;i<12;i++)store.listEvidenceIndex();return value;}};
 const originalIndex=store.listEvidenceIndex,originalList=host.list;
 const probe=createDenseResidualProbe.call(store,host,{workspaceId:'fixture'},{longWatch:true,eventLoopReads:true,durationMs:10000});
 const queue=createReadTicketQueue(probe,{owner:'test-owner',epoch:'test-source',maxQueueMs:ttl,allowExposure});
 t.after(()=>{probe.stop();fs.rmSync(dir,{recursive:true,force:true});});return {store,host,probe,queue,seen,value,originalIndex,originalList};
}
test('completion notice is after the read, expiry is a fact not a read, and later binding owners survive stop',async t=>{
 const f=fixture(t),name='__ri00_controller_done_'+'a'.repeat(32),notices=[];globalThis[name]=id=>{assert.equal(f.probe.queueContext().activeDepth,0);notices.push(id);};t.after(()=>delete globalThis[name]);
 f.queue.attachCompletionNotice(name);f.queue.request({id:1,kind:'witness',label:'notice'});assert.deepEqual(notices,[]);await turn();assert.deepEqual(notices,['1']);await f.probe.take();f.probe.ack();f.queue.ack(1);
 f.queue.request({id:2,kind:'witness',label:'stop-before-run'});const count=f.seen.length;assert.equal(f.probe.stop().restored,true);await turn();assert.equal(f.seen.length,count);assert.equal(f.queue.status(2).state,'expired');assert.deepEqual(notices,['1','2']);assert.equal(globalThis[name],undefined);
 const g=fixture(t);globalThis[name]=()=>{};g.queue.attachCompletionNotice(name);const later=()=>{};globalThis[name]=later;assert.throws(()=>g.queue.request({id:1,kind:'witness',label:'changed-owner'}),/notice_owner_changed/);assert.equal(g.probe.stop().restored,false);assert.equal(globalThis[name],later);
});
test('request inside a synchronous application call executes only after the outer stack returns',async t=>{
 let request,queue;const order=[];const f=fixture(t,{list(input,store,value){order.push('enter');if(!request){request=queue.request({id:1,kind:'witness',label:'first'});order.push('requested');assert.equal(request.state,'queued');assert.equal(queue.status(1).completedRows.length,0);}for(let i=0;i<12;i++)store.listEvidenceIndex();order.push('leave');return value;}});queue=f.queue;
 assert.equal(f.host.list({workspaceId:'fixture'}),f.value);assert.deepEqual(order,['enter','requested','leave']);await turn();assert.deepEqual(order,['enter','requested','leave','enter','leave']);assert.equal(queue.status(1).state,'completed');
 const batch=await f.probe.take();assert.deepEqual(batch.rows.map(x=>x.origin),['natural','controlled']);assert.equal(batch.rows[1].ticketId,1);assert.equal(batch.rows[1].readKind,'witness');assert.equal(batch.rows[1].samplingSchema,'heap-free-witness-v1');assert.equal(batch.rows[1].heapBefore,null);assert.equal(batch.rows[1].heapAfter,null);assert.equal(batch.rows[1].evidence.length,12);assert.equal(typeof batch.rows[1].evidence[0].processUserMs,'number');
 assert.throws(()=>queue.request({id:2,kind:'witness',label:'busy'}),/slot_occupied/);f.probe.ack();queue.ack(1);
});
test('single unacknowledged slot is idempotent, stale IDs never reexecute and acknowledged conflicts reject',async t=>{
 const f=fixture(t),request={id:1,kind:'witness',label:'kept'};f.queue.request(request);assert.throws(()=>f.queue.ack(1),/ack_invalid/);assert.throws(()=>f.probe.read('bypass'),/event_loop_read_required/);await turn();const calls=f.seen.length;
 assert.equal(f.queue.request(request).state,'completed');assert.equal(f.seen.length,calls);const a=await f.probe.take();assert.equal(await f.probe.take(),a);f.probe.ack();assert.equal(f.queue.ack(1),true);assert.equal(f.queue.ack(1),true);
 assert.equal(f.queue.request(request).state,'acknowledged');assert.equal(f.seen.length,calls);assert.throws(()=>f.queue.request({...request,kind:'dense'}),/conflict/);
 f.queue.request({id:2,kind:'witness',label:'next'});await turn();await f.probe.take();f.probe.ack();f.queue.ack(2);assert.throws(()=>f.queue.request(request),/stale_id/);
});
test('witness lifecycle calls zero V8 heap getters; dense control keeps the original active metric',async t=>{
 const v8=process.getBuiltinModule('v8'),names=['getHeapStatistics','getHeapSpaceStatistics','getHeapCodeStatistics'],old=Object.fromEntries(names.map(n=>[n,v8[n]])),count=Object.fromEntries(names.map(n=>[n,0]));
 for(const n of names)v8[n]=(...args)=>{count[n]++;return old[n](...args);};t.after(()=>{for(const n of names)v8[n]=old[n];});
 const f=fixture(t);f.queue.request({id:1,kind:'witness',label:'no-heap'});await turn();f.probe.renew();f.probe.vm();await f.probe.take();f.probe.ack();f.queue.ack(1);assert.deepEqual(Object.values(count),[0,0,0]);
 f.queue.request({id:2,kind:'dense',label:'original-metric'});await turn();const batch=await f.probe.take();f.probe.ack();f.queue.ack(2);assert.equal(batch.rows[0].samplingSchema,'controlled-heap-v1');assert.ok(batch.rows[0].heapBefore.spaces.length);assert.ok(count.getHeapStatistics>0&&count.getHeapSpaceStatistics>0);assert.equal(count.getHeapCodeStatistics,0);f.probe.stop();
});
test('expired queue and stop-before-dispatch perform no business read',async t=>{
 const performance=process.getBuiltinModule('perf_hooks').performance;let now=performance.now();t.mock.method(performance,'now',()=>now);
 const f=fixture(t,{ttl:1});f.queue.request({id:1,kind:'witness',label:'expiry'});now+=2;await turn();assert.equal(f.queue.status(1).state,'expired');assert.equal(f.seen.length,0);await f.probe.take();f.probe.ack();f.queue.ack(1);
 f.queue.request({id:2,kind:'witness',label:'stopped'});const end=f.probe.stop();await turn();assert.equal(f.queue.status(2).state,'expired');assert.equal(f.seen.length,0);assert.equal(end.readQueue.immediatePending,false);assert.equal(end.readQueue.deadlinePending,false);assert.equal(end.restored,true);
});
test('original errors are transparent, failed tickets are retained and subsequent reads are admitted after ACK',async t=>{
 const failure=Error('original-reader'),f=fixture(t,{list(input,store,value){store.listEvidenceIndex();if(this.fail)throw failure;return value;}});f.host.fail=true;assert.throws(()=>f.host.list({workspaceId:'fixture'}),x=>x===failure);
 f.queue.request({id:1,kind:'witness',label:'failure'});await turn();assert.equal(f.queue.status(1).state,'failed');assert.equal(f.queue.status(1).error.message,failure.message);let b=await f.probe.take();assert.ok(b.rows.every(x=>x.readFailure));assert.ok(b.state.controlledCpuMs>=0);f.probe.ack();f.queue.ack(1);
 f.host.fail=false;f.queue.request({id:2,kind:'witness',label:'recovered'});await turn();b=await f.probe.take();f.probe.ack();f.queue.ack(2);assert.equal(b.rows[0].readFailure,undefined);assert.equal(f.queue.status(2).previousState,'completed');
});
test('late method owner is preserved and pending request cannot execute against it',async t=>{
 const f=fixture(t),replacement=()=>[];f.queue.request({id:1,kind:'witness',label:'owner'});f.host.list=replacement;await turn();assert.equal(f.queue.status(1).state,'expired');assert.equal(f.queue.status(1).reason,'method-owner-changed');assert.equal(f.seen.length,0);const end=f.probe.stop();assert.equal(end.restored,false);assert.equal(f.host.list,replacement);assert.equal(f.store.listEvidenceIndex,f.originalIndex);
});
test('a stop during a synchronous read records in-flight recovery and never executes later exposure steps',async t=>{
 let probe,snapshot;const f=fixture(t,{list(input,store,value){snapshot=probe.stop('test-reentrant-stop');store.listEvidenceIndex();return value;},allowExposure:true});probe=f.probe;
 f.queue.request({id:1,kind:'order-supervisor-first',label:'partial'});await turn();assert.equal(snapshot.readQueue.inFlight,true);assert.equal(f.queue.status(1).state,'failed');assert.equal(f.queue.status(1).completedRows.length,1);assert.equal(f.queue.status(1).stoppedDuringRun,true);assert.equal(probe.stop().readQueue.inFlight,false);assert.equal(f.host.list,f.originalList);
});
test('order tickets use fixed equal operation multisets and never serialize full Evidence results',async t=>{
 const f=fixture(t,{allowExposure:true});for(const [id,kind]of[[1,'order-index-first'],[2,'order-supervisor-first']]){
  f.seen.length=0;f.queue.request({id,kind,label:'exposure'});await turn();const s=f.queue.status(id),b=await f.probe.take();assert.equal(s.state,'completed');assert.equal(s.completedRows.length,9);assert.equal(b.rows.length,9);assert.equal(b.rows.filter(r=>r.readKind==='exposure-index').length,8);assert.ok(b.rows.filter(r=>r.readKind==='exposure-index').every(r=>r.outputSha256===undefined&&r.heapBefore===null));assert.equal(b.rows.filter(r=>r.readKind==='exposure-supervisor')[0].evidence.length,12);assert.equal(f.seen.filter(x=>x==='list').length,1);assert.equal(f.seen.filter(x=>x==='index').length,20);assert.equal(f.seen.indexOf('list'),id===1?8:0);f.probe.ack();f.queue.ack(id);
 }
});
test('invalid source, oversize deadline, unowned exposure and second queue installation reject without reads',t=>{
 const f=fixture(t);for(const request of [{id:1,kind:'witness',label:'x',sourceEpoch:'different'},{id:1,kind:'witness',label:'x',ttlMs:5001},{id:1,kind:'order-index-first',label:'x'}])assert.throws(()=>f.queue.request(request),/request_invalid/);
 assert.throws(()=>createReadTicketQueue(f.probe,{owner:'other',epoch:'test-source'}),/attach_invalid/);assert.equal(f.seen.length,0);
});
test('the exact serialized installer has no external closure and recovers its methods',async t=>{
 const f=fixture(t);f.probe.stop();const install=Function('return ('+e3InstallerSource()+')')();
 const e3=install.call(f.store,f.host,{workspaceId:'fixture'},{durationMs:10000,queue:{owner:'serialized',epoch:'fixed'}});t.after(()=>e3.probe.stop());
 e3.queue.request({id:1,kind:'witness',label:'serialized'});await turn();assert.equal(e3.queue.status(1).state,'completed');const b=await e3.probe.take();assert.equal(b.rows[0].evidence.length,12);assert.equal(b.rows[0].heapBefore,null);assert.equal(b.rows[0].ticketId,1);e3.probe.ack();e3.queue.ack(1);assert.equal(e3.probe.stop().restored,true);assert.equal(f.host.list,f.originalList);
});
