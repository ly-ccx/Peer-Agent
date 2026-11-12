import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import { captureFixtureLayout,summarizeFixtureLayout } from './heap-layout.mjs';

test('heap capture refuses an unowned process before writing a snapshot',()=>{
  assert.throws(()=>captureFixtureLayout.call({records:[{}]},()=>({}),'/unused/layout.private.heapsnapshot'),/requires_owned_fixture/);
});
test('real heap schema projects tagged sample sizes without values or addresses',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ri00-layout-test-'));
  try{
    globalThis.__ri00LayoutSelectedSamples=Array.from({length:64},()=>({raw:{evidenceRef:'private-layout-sentinel',createdAt:'fixture-date',artifactRefs:['private-layout-sentinel']},output:{evidenceRef:'private-layout-sentinel',createdAt:'fixture-date'}}));
    const file=path.join(root,'fixture.private.heapsnapshot');v8.writeHeapSnapshot(file,{exposeInternals:true});
    const snapshot=JSON.parse(fs.readFileSync(file,'utf8')),result=summarizeFixtureLayout(snapshot);
    assert.equal(result.samples.length,64);assert.ok(result.samples.every(row=>row.raw.selfBytes>0&&row.output.selfBytes>0&&row.raw.fields.evidenceRef.type==='string'));
    assert.equal(JSON.stringify(result).includes('private-layout-sentinel'),false);assert.equal(JSON.stringify(result).includes('0x'),false);
    const index=snapshot.strings.indexOf('__ri00LayoutSelectedSamples');snapshot.strings[index]='removed-layout-root';
    assert.throws(()=>summarizeFixtureLayout(snapshot),/unique_heap_layout_root_required/);
  }finally{delete globalThis.__ri00LayoutSelectedSamples;fs.rmSync(root,{recursive:true,force:true});}
});
test('unknown heap schema fails instead of guessing offsets',()=>{
  assert.throws(()=>summarizeFixtureLayout({snapshot:{meta:{}}}),/unsupported_heap_layout_schema/);
});
