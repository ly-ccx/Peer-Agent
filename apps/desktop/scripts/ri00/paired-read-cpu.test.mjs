import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { controlledSessionRead } from './paired-read-cpu.mjs';

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ri00-cpu-read-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'evidence-index.jsonl'),'{}\n');
  const store={getStoreDir:()=>root,getPlan:()=>({status:'completed'}),listEvidenceIndex:()=>[{}]};
  return {root,store,original:{...store}};
}
test('paired CPU probe preserves read results, source identity, and method ownership',async t=>{
  const {store,original}=fixture(t);const expected=[{sessionId:'fixture-session'}];
  const supervisor={list(){assert.equal(store.getPlan().status,'completed');store.listEvidenceIndex();return expected;}};
  const result=await controlledSessionRead.call(supervisor,store,{workspaceId:'fixture'});
  assert.equal(result.ok,true);assert.equal(result.sourceUnchanged,true);assert.deepEqual(result.restored,[true,true]);
  assert.equal(result.reads.length,3);assert.ok(result.reads.every(row=>row.getPlanCalls===1&&row.sessions===1&&row.evidence.length===1));
  assert.equal(store.getPlan,original.getPlan);assert.equal(store.listEvidenceIndex,original.listEvidenceIndex);
  assert.deepEqual(supervisor.list(),expected);
});
test('failed production read restores owned methods without claiming valid measurements',async t=>{
  const {store,original}=fixture(t);
  const result=await controlledSessionRead.call({list(){store.getPlan();throw Object.assign(new Error('private failure'),{code:'fixture_failure'});}},store,{});
  assert.equal(result.ok,false);assert.deepEqual(result.failures,[{name:'Error',code:'fixture_failure'}]);
  assert.equal(store.getPlan,original.getPlan);assert.equal(store.listEvidenceIndex,original.listEvidenceIndex);
  assert.equal(JSON.stringify(result).includes('private failure'),false);
});
test('late owner replacement is preserved and blocks probe acceptance',async t=>{
  const {store}=fixture(t),replacement=()=>[];
  const result=await controlledSessionRead.call({list(){store.listEvidenceIndex=replacement;throw new Error('owner changed');}},store,{});
  assert.equal(result.ok,false);assert.equal(result.restored.includes(false),true);assert.equal(store.listEvidenceIndex,replacement);
});
