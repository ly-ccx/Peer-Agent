import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import { createE3EntryAdapter } from './e3-entry-adapter.mjs';
import { e3SiteInstallerSource } from './e3-site-install.mjs';

test('entries preserve receiver, original value/error and Promise identity with actual async parents',async()=>{
  const value={},error=Error('original');let resolve;
  const api={child(){assert.equal(this,api);return value;},async parent(){await new Promise(r=>{resolve=r;});return api.child();},fail(){throw error;}};
  const original={...api},observer=createE3EntryAdapter(Object.keys(api).map(key=>({object:api,key,kind:key})),[],{epoch:'owned'});
  try{const promise=api.parent();const concurrent=api.child();assert.equal(concurrent,value);resolve();assert.equal(await promise,value);
    assert.throws(()=>api.fail(),e=>e===error);const rows=observer.take().entries;
    assert.equal(rows.find(r=>r.seq===3).parentSeq,1);assert.equal(rows.find(r=>r.seq===2).parentSeq,null);
    assert.equal(rows[0].completion,'fulfilled');assert.equal(rows.at(-1).completion,'threw');
  }finally{assert.equal(observer.stop().restored,true);assert.deepEqual(api,original);}
  const promise=Promise.resolve(value),object={read:()=>promise};const other=createE3EntryAdapter([{object,key:'read',kind:'read'}],[],{epoch:'owned'});
  assert.equal(object.read(),promise);await promise;other.stop();
});
test('unacknowledged revisions stay immutable and asynchronous settlement is delivered after ACK',async()=>{
  let resolve;const object={read:()=>new Promise(r=>{resolve=r;})},o=createE3EntryAdapter([{object,key:'read',kind:'read'}],[],{epoch:'owned'});
  try{const p=object.read(),first=o.take(),snapshot=JSON.stringify(first);resolve();await p;await Promise.resolve();
    assert.equal(o.take(),first);assert.equal(JSON.stringify(first),snapshot);o.ack();const second=o.take();
    assert.equal(second.entries.length,1);assert.equal(second.entries[0].completion,'fulfilled');assert.ok(second.entries[0].revision>first.entries[0].revision);
    o.ack();assert.equal(o.take().entries.length,0);o.ack();
  }finally{o.stop();}
});
test('record cap calls a throwing original exactly once and late owners are never overwritten',()=>{
  let calls=0;const error=Error('owned-error'),object={read(){calls++;throw error;}},o=createE3EntryAdapter([{object,key:'read',kind:'read'}],[],{epoch:'owned',maxRecords:1});
  assert.throws(()=>object.read(),e=>e===error);assert.throws(()=>object.read(),e=>e===error);assert.equal(calls,2);assert.equal(o.state().reason,'entry-record-cap');
  const next={read(){}},p=createE3EntryAdapter([{object:next,key:'read',kind:'read'}],[],{epoch:'owned'}),later=()=>{};
  next.read=later;assert.equal(p.stop().restored,false);assert.equal(next.read,later);
});
test('payload shape does not read accessors or proxy traps and never stores parameter values',()=>{
  let traps=0;const object={read:()=>true},o=createE3EntryAdapter([{object,key:'read',kind:'read'}],[],{epoch:'owned'});
  try{object.read({get workspaceId(){traps++;return 'personal-id';}});object.read(new Proxy({},{get(){traps++;return 'personal-id';},getOwnPropertyDescriptor(){traps++;return undefined;}}));
    assert.equal(traps,0);assert.ok(!JSON.stringify(o.take().entries).includes('personal-id'));
  }finally{o.stop();}
});
test('finite integer budgets reject and an original Promise settling after stop updates actual in-flight recovery',async()=>{
  const object={read(){}};assert.throws(()=>createE3EntryAdapter([{object,key:'read',kind:'read'}],[],{epoch:'owned',maxRecords:NaN}),/bounds/);
  let resolve;object.read=()=>new Promise(r=>{resolve=r;});const o=createE3EntryAdapter([{object,key:'read',kind:'read'}],[],{epoch:'owned'});
  const p=object.read();assert.equal(o.stop().inFlight,1);resolve();await p;await Promise.resolve();assert.equal(o.state().inFlight,0);assert.equal(o.take().entries[0].completedAfterStop,true);
});
test('serialized site installer links batch-reader roots, keeps all heap getters at zero and restores every layer',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ri00-e3-site-unit-'));fs.writeFileSync(path.join(dir,'evidence-index.jsonl'),'{}\n');
  const values=[{}],store={getStoreDir:()=>dir,getPlan:()=>({}),listEvidenceIndex:()=>values};
  const sup={list(){for(let i=0;i<12;i++){store.getPlan();store.listEvidenceIndex();}return values;},listByWorkspaceIds(ids){return new Map(ids.map(id=>[id,sup.list()]));}};
  const api={list:()=>sup.listByWorkspaceIds(['owned'])},original={list:sup.list,batch:sup.listByWorkspaceIds,index:store.listEvidenceIndex,plan:store.getPlan,entry:api.list};
  const names=['getHeapStatistics','getHeapSpaceStatistics','getHeapCodeStatistics'],getters=Object.fromEntries(names.map(n=>[n,v8[n]]));let count=0,site;
  for(const name of names)v8[name]=(...args)=>{count++;return getters[name](...args);};
  try{const install=Function('return ('+e3SiteInstallerSource()+')')();site=install.call(store,sup,{workspaceId:'owned'},{longWatch:true,durationMs:5000,leaseMs:1000,queue:{owner:'unit',epoch:'owned'}},
    {entries:[{object:api,key:'list',kind:'ipc-list'}],readers:[{object:store,key:'getPlan',port:'plan',layered:true},{object:store,key:'listEvidenceIndex',port:'index',layered:true},{object:sup,key:'list',port:'supervisor-list',layered:true},{object:sup,key:'listByWorkspaceIds',port:'supervisor-batch',layered:true}]});
    const result=api.list();assert.ok(result instanceof Map);const batch=await site.probe.take();
    assert.ok(batch.rows.some(r=>r.rootMethod==='listByWorkspaceIds'&&r.entryContext.kind==='ipc-list'));
    assert.equal(site.entries.take().entries[0].planCalls,12);site.entries.ack();site.probe.ack();site.probe.vm();site.renew();
    const stop=site.probe.stop();assert.equal(stop.restored,true);assert.equal(stop.entryAdapter.restored,true);assert.equal(count,0);
    assert.equal(sup.list,original.list);assert.equal(sup.listByWorkspaceIds,original.batch);assert.equal(store.getPlan,original.plan);assert.equal(store.listEvidenceIndex,original.index);assert.equal(api.list,original.entry);
  }finally{site?.probe.stop();for(const name of names)v8[name]=getters[name];fs.rmSync(dir,{recursive:true,force:true});}
});
test('a later entry owner invalidates direct ticket dispatch before any product read',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ri00-entry-owner-'));fs.writeFileSync(path.join(dir,'evidence-index.jsonl'),'{}\n');let reads=0;
  const store={getStoreDir:()=>dir,listEvidenceIndex:()=>[]},sup={list(){reads++;return[];}},api={list:()=>sup.list()};
  const install=Function('return ('+e3SiteInstallerSource()+')')(),site=install.call(store,sup,{workspaceId:'owned'},
    {durationMs:5000,leaseMs:1000,queue:{owner:'unit',epoch:'owned'}},{entries:[{object:api,key:'list',kind:'ipc-list'}],readers:[]});
  const later=()=>[];api.list=later;site.queue.request({id:1,kind:'witness',label:'owner-changed'});await new Promise(r=>setImmediate(r));
  try{assert.equal(site.queue.status(1).state,'expired');assert.equal(reads,0);assert.equal(site.probe.stop().restored,false);assert.equal(api.list,later);}
  finally{site.probe.stop();fs.rmSync(dir,{recursive:true,force:true});}
});
