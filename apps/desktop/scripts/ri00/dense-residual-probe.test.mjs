import test from 'node:test';import assert from 'node:assert/strict';import fs from'node:fs';import os from'node:os';import path from'node:path';
import {createDenseResidualProbe} from './dense-residual-probe.mjs';

test('owned counter uses 26 fixed slots, OFF calls none, and counter failure preserves the original read error',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ri00-pass-work-'));fs.writeFileSync(path.join(dir,'evidence-index.jsonl'),'{}\n');
 const key='__ri00_owned_test_counter',calls=[],data=[{}],error=Error('original-read'),store={getStoreDir:()=>dir,listEvidenceIndex:()=>data};let fail=false,counterFail=false;
 const host={list(){for(let i=0;i<12;i++)store.listEvidenceIndex();if(fail)throw error;return data;}};
 globalThis[key]={stride:44,levels:1,numer:1,denom:1,writeInto(a,slot){calls.push(slot);if(counterFail)throw Error('native-failure');a[slot*44]=9n;}};
 const probe=createDenseResidualProbe.call(store,host,{workspaceId:'fixture'},{longWatch:true,eventLoopReads:true,ownedExperiment:true,ownedPassCounterKey:key,durationMs:10000});
 t.after(()=>{probe.stop();delete globalThis[key];fs.rmSync(dir,{recursive:true,force:true});});
 assert.equal(host.list({workspaceId:'fixture'}),data);let b=await probe.take();probe.ack();assert.equal(b.rows[0].passWork.slots,0);assert.equal(calls.length,0);
 probe.setPassCounter(true);assert.equal(host.list({workspaceId:'fixture'}),data);b=await probe.take();probe.ack();assert.deepEqual(calls,Array.from({length:26},(_,i)=>i));assert.equal(b.rows[0].passWork.slots,26);
 counterFail=true;fail=true;assert.throws(()=>host.list({workspaceId:'fixture'}),e=>e===error);b=await probe.take();probe.ack();assert.equal(b.rows[0].passWork.failed,true);assert.equal(b.rows[0].readFailure,true);assert.equal(b.state.metadataErrors,1);assert.equal(probe.stop().restored,true);
});

test('long probe notifies without queries, retains an idempotent unacknowledged batch and releases archived metadata',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ri00-long-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.writeFileSync(path.join(dir,'evidence-index.jsonl'),'{}\n');
  let notices=0,calls=0;const binding='__ri00_test_natural_notice';globalThis[binding]=()=>notices++;
  const store={getStoreDir:()=>dir,listEvidenceIndex:()=>[{}]},value=[{}],host={list(){calls++;for(let i=0;i<12;i++)store.listEvidenceIndex();return value;}};
  const original=host.list,probe=createDenseResidualProbe.call(store,host,{workspaceId:'fixture'},{longWatch:true,durationMs:10000,leaseMs:10000,notificationName:binding});t.after(()=>probe.stop());
  for(let block=0;block<3;block++){
    for(let i=0;i<100;i++)assert.equal(host.list({workspaceId:'fixture'}),value);
    const pending=probe.take();assert.equal(probe.take(),pending);const batch=await pending;assert.equal(batch.rows.length,100);assert.ok(batch.state.retainedRowBytes>0);
    assert.equal(batch.rows[0].evidence.length,12);assert.match(batch.rows[0].evidence[0].entryStack,/dense-residual-probe\.test\.mjs/);assert.equal(batch.rows[0].samplingSchema,'passive-cpu-v2');assert.equal(batch.rows[0].heapBefore,null);assert.equal(batch.rows[0].heapAfter,null);assert.equal(batch.rows[0].evidence[0].newSpaceBefore,undefined);assert.equal(batch.rows[0].evidence[0].gc.absenceNotProven,true);probe.ack();
  }
  const empty=await probe.take();assert.equal(empty.rows.length,0);assert.equal(empty.state.retainedRowBytes,0);assert.equal(empty.state.naturalRows,300);assert.equal(empty.state.dropped,0);probe.ack();
  assert.equal(calls,300);assert.ok(notices>0&&notices<=4);assert.equal(probe.stop().bindingRestored,true);assert.equal(globalThis[binding],undefined);assert.equal(host.list,original);
});
test('long probe lease restores owned methods and leaves a later notification owner intact',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ri00-long-lease-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.writeFileSync(path.join(dir,'evidence-index.jsonl'),'{}\n');
  const binding='__ri00_test_lease_notice',store={getStoreDir:()=>dir,listEvidenceIndex:()=>[]},host={list:()=>[]},original=host.list;globalThis[binding]=()=>{};
  const probe=createDenseResidualProbe.call(store,host,{workspaceId:'fixture'},{longWatch:true,durationMs:10000,leaseMs:100,notificationName:binding});
  const replacement=()=>{};globalThis[binding]=replacement;await new Promise(r=>setTimeout(r,170));
  const state=probe.stop();assert.equal(state.restored,true);assert.equal(state.stopReason,'controller-lease');assert.equal(state.bindingRestored,false);assert.equal(host.list,original);assert.equal(globalThis[binding],replacement);delete globalThis[binding];
});
test('persistent probe preserves application results/errors and streams metadata without reinstalling methods',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ri00-dense-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.writeFileSync(path.join(dir,'evidence-index.jsonl'),'{}\n');
  const store={getStoreDir:()=>dir,listEvidenceIndex:()=>[{}]},value=[{}],failure=Error('original');const host={list(input){store.listEvidenceIndex();if(input.fail)throw failure;return value;}};
  const originalIndex=store.listEvidenceIndex,originalList=host.list,limit=Object.getOwnPropertyDescriptor(Error,'stackTraceLimit');
  const probe=createDenseResidualProbe.call(store,host,{workspaceId:'fixture'}),take=async()=>{const r=await probe.take();probe.ack();return r;};assert.equal(host.list({workspaceId:'fixture'}),value);
  assert.throws(()=>host.list({fail:true}),e=>e===failure);const installed=host.list;const pending=probe.take();assert.throws(()=>probe.take(),/ack_required/);const first=await pending;probe.ack();assert.equal(first.rows.length,2);assert.equal(first.rows[1].readFailure,true);
  assert.equal(first.rows[0].evidence.length,1);assert.ok(first.rows[0].entryStack.includes('root'));assert.equal((await take()).rows.length,0);
  probe.read('baseline');assert.equal(host.list,installed);assert.equal((await take()).rows[0].origin,'controlled');
  probe.setDetail('bare');assert.equal(host.list,originalList);probe.read('bare');assert.equal((await take()).rows[0].evidence.length,0);
  probe.setDetail('detailed');assert.equal(host.list,installed);probe.read('repeat');assert.equal((await take()).rows[0].evidence.length,1);
  store.listEvidenceIndex();store.listEvidenceIndex();const outside=await take();assert.equal(outside.rows.length,2);assert.equal(outside.rows[0].origin,'outside-index');
  assert.equal(outside.rows[0].evidence.length,1);assert.equal(outside.rows[0].outputSha256,undefined);assert.ok(outside.rows[0].entryStack);assert.equal(outside.rows[1].entryStack,null);
  assert.equal(probe.stop().restored,true);assert.equal(host.list,originalList);assert.equal(store.listEvidenceIndex,originalIndex);assert.deepEqual(Object.getOwnPropertyDescriptor(Error,'stackTraceLimit'),limit);
});
test('persistent probe watchdog and late-owner handling recover without overwriting another owner',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ri00-dense-watch-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.writeFileSync(path.join(dir,'evidence-index.jsonl'),'{}\n');
  const store={getStoreDir:()=>dir,listEvidenceIndex:()=>[{}]},host={list:()=>[]};
  assert.throws(()=>createDenseResidualProbe.call(store,host,{},{durationMs:1200001}),/bounded/);
  const probe=createDenseResidualProbe.call(store,host,{},{durationMs:100}),replacement=()=>[];host.list=replacement;
  await new Promise(r=>setTimeout(r,150));const end=probe.stop();assert.equal(end.timedOut,true);assert.equal(end.restored,false);assert.equal(host.list,replacement);assert.throws(()=>probe.read('late'),/stopped/);
});

test('passive natural, outside, take, VM summary, renew and stop never invoke V8 heap getters',async t=>{
 const v8=process.getBuiltinModule('v8'),names=['getHeapStatistics','getHeapSpaceStatistics','getHeapCodeStatistics'],calls=Object.fromEntries(names.map(n=>[n,0])),original=Object.fromEntries(names.map(n=>[n,v8[n]]));
 for(const n of names)v8[n]=function(...args){calls[n]++;return Reflect.apply(original[n],this,args);};
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ri00-passive-vm-'));let probe;t.after(()=>{probe?.stop();for(const n of names)v8[n]=original[n];fs.rmSync(dir,{recursive:true,force:true});});fs.writeFileSync(path.join(dir,'evidence-index.jsonl'),'{}\n');
 const data=[{}],value=[{}],store={getStoreDir:()=>dir,listEvidenceIndex:()=>data},host={list(){for(let i=0;i<12;i++)store.listEvidenceIndex();return value;}};
 probe=createDenseResidualProbe.call(store,host,{workspaceId:'fixture'},{longWatch:true,durationMs:10000});
 assert.equal(host.list({workspaceId:'fixture'}),value);store.listEvidenceIndex();probe.renew();assert.equal(probe.vm().sample,null);const natural=await probe.take();probe.ack();assert.equal(natural.heap,null);assert.equal(natural.rows.length,2);assert.deepEqual(Object.values(calls),[0,0,0]);
 probe.read('controlled');assert.ok(calls.getHeapStatistics>0&&calls.getHeapSpaceStatistics>0);assert.equal(calls.getHeapCodeStatistics,0);const before={...calls};assert.ok(probe.vm().sample.heapAfter);await probe.take();probe.ack();probe.renew();probe.stop();assert.deepEqual(calls,before);
});
