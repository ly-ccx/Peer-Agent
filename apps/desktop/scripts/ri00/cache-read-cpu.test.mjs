import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { controlledCacheRead } from './cache-read-cpu.mjs';

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ri00-cache-read-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'evidence-index.jsonl'),'{"ref":"fixture"}\n');
  const read=()=>[{ref:'fixture'}],cache={version:'fixture-version',records:read()};return {root,read,cache};
}
test('cache comparison binds equal raw and normalized facts without replacing either record array',async t=>{
  const {root,read,cache}=fixture(t),old=cache.records,normalize=row=>({...row}),retain=rows=>rows;
  const result=await controlledCacheRead.call(cache,normalize,retain,read,()=>cache.records.map(normalize),root);
  assert.equal(result.ok,true);assert.equal(result.cacheUnchanged,true);assert.equal(cache.records,old);
  assert.equal(result.oldDigest,result.freshDigest);assert.equal(new Set(Object.values(result.outputs)).size,1);
  assert.equal(result.reads.length,18);assert.deepEqual([...new Set(result.reads.map(row=>row.name))].sort(),['existing','fresh','reader']);
});
test('different cached facts invalidate comparison before collecting timing samples',async t=>{
  const {root,read,cache}=fixture(t);cache.records=[{ref:'different-private-ref'}];
  const result=await controlledCacheRead.call(cache,row=>({...row}),rows=>rows,read,()=>cache.records,root);
  assert.equal(result.ok,false);assert.equal(result.cacheUnchanged,true);assert.equal(result.reads.length,0);
  assert.equal(result.failures[0].message,'cache_raw_records_differ');assert.equal(JSON.stringify(result).includes('different-private-ref'),false);
});
