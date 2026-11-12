import test from 'node:test';import assert from 'node:assert/strict';import fs from'node:fs';import os from'node:os';import path from'node:path';
import {createDenseResidualProbe} from './dense-residual-probe.mjs';
test('persistent probe preserves application results/errors and streams metadata without reinstalling methods',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ri00-dense-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.writeFileSync(path.join(dir,'evidence-index.jsonl'),'{}\n');
  const store={getStoreDir:()=>dir,listEvidenceIndex:()=>[{}]},value=[{}],failure=Error('original');const host={list(input){store.listEvidenceIndex();if(input.fail)throw failure;return value;}};
  const originalIndex=store.listEvidenceIndex,originalList=host.list,limit=Object.getOwnPropertyDescriptor(Error,'stackTraceLimit');
  const probe=createDenseResidualProbe.call(store,host,{workspaceId:'fixture'});assert.equal(host.list({workspaceId:'fixture'}),value);
  assert.throws(()=>host.list({fail:true}),e=>e===failure);const installed=host.list;const first=await probe.take();assert.equal(first.rows.length,2);assert.equal(first.rows[1].readFailure,true);
  assert.equal(first.rows[0].evidence.length,1);assert.ok(first.rows[0].entryStack.includes('root'));assert.equal((await probe.take()).rows.length,0);
  probe.read('baseline');assert.equal(host.list,installed);assert.equal((await probe.take()).rows[0].origin,'controlled');
  probe.setDetail('bare');assert.equal(host.list,originalList);probe.read('bare');assert.equal((await probe.take()).rows[0].evidence.length,0);
  probe.setDetail('detailed');assert.equal(host.list,installed);probe.read('repeat');assert.equal((await probe.take()).rows[0].evidence.length,1);
  store.listEvidenceIndex();store.listEvidenceIndex();const outside=await probe.take();assert.equal(outside.rows.length,2);assert.equal(outside.rows[0].origin,'outside-index');
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
