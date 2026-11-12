import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createIndexCounterProbe } from './index-counter-probe.mjs';
test('counter probe leaves the source and methods intact and ends its observer',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ri00-index-counters-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'evidence-index.jsonl');fs.writeFileSync(file,'{}\n');
  const store={getStoreDir:()=>root,listEvidenceIndex:()=>[{}]},original=store.listEvidenceIndex;
  const probe=createIndexCounterProbe.call(store),read=probe.read('index');probe.read('noop');probe.read('native');
  await new Promise(resolve=>setTimeout(resolve,20));const result=probe.stop();
  assert.equal(read.rows,1);assert.equal(read.sourceStable,true);assert.equal(result.reads.length,3);assert.equal(result.stopped,true);
  assert.equal(store.listEvidenceIndex,original);assert.equal(fs.readFileSync(file,'utf8'),'{}\n');
  assert.deepEqual(probe.stop(),result);assert.throws(()=>probe.read('index'),/stopped/);
});
test('isolated session counter captures production evidence spans and restores its owned method',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ri00-session-counters-'));
  try{
    fs.writeFileSync(path.join(root,'evidence-index.jsonl'),'{}\n');const store={getStoreDir:()=>root,listEvidenceIndex:()=>[{}]},original=store.listEvidenceIndex;
    const supervisor={list(){store.listEvidenceIndex();store.listEvidenceIndex();return [{sessionId:'fixture'}];}};
    const probe=createIndexCounterProbe.call(store,supervisor,{workspaceId:'fixture'}),row=probe.read('session');
    assert.equal(row.rows,1);assert.equal(row.evidence.length,2);assert.equal(probe.stop().restored,true);assert.equal(store.listEvidenceIndex,original);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('counter cleanup preserves a late owner and flags incomplete restoration',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ri00-counter-owner-'));
  try{
    fs.writeFileSync(path.join(root,'evidence-index.jsonl'),'{}\n');const store={getStoreDir:()=>root,listEvidenceIndex:()=>[{}]},replacement=()=>[];
    const probe=createIndexCounterProbe.call(store,{list:()=>[]},{});store.listEvidenceIndex=replacement;
    assert.equal(probe.stop().restored,false);assert.equal(store.listEvidenceIndex,replacement);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
