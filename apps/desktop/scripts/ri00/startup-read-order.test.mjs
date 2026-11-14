import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { installStartupReadOrder } from './startup-read-order.mjs';

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ri00-startup-order-')),alias=root+'-alias';fs.symlinkSync(root,alias,'dir');
  fs.writeFileSync(path.join(root,'plan.json'),'private-plan-body');fs.writeFileSync(path.join(root,'evidence-index.jsonl'),'private-index-body');
  t.after(()=>{fs.rmSync(alias);fs.rmSync(root,{recursive:true,force:true});});
  return {root,alias,deps:{fs,path,now:()=>performance.now(),timers:globalThis,syncExports:syncBuiltinESMExports}};
}
test('startup probe keeps late first-index evidence beyond the early-event cap and supports canonical aliases',t=>{
  const {root,alias,deps}=fixture(t),original=fs.readFileSync,probe=installStartupReadOrder(deps,{storeRoot:alias,durationMs:1000});t.after(()=>probe.stop());
  for(let i=0;i<300;i++)assert.equal(fs.readFileSync(path.join(root,'plan.json'),'utf8'),'private-plan-body');
  fs.readFileSync(path.join(alias,'evidence-index.jsonl'));
  const result=probe.stop();assert.equal(result.restored,true);assert.equal(fs.readFileSync,original);
  assert.deepEqual(result.counts,{plan:300,index:1});assert.equal(result.events.length,257);assert.equal(result.dropped,44);
  assert.equal(result.events.at(-1).countsBefore.plan,300);assert.equal(result.events.at(-1).sequence,301);
  assert.equal(JSON.stringify(result).includes('private-plan-body'),false);assert.equal(JSON.stringify(result).includes('private-index-body'),false);
});
test('startup probe preserves thrown errors and a later method owner',t=>{
  const {root,deps}=fixture(t),original=fs.readFileSync,probe=installStartupReadOrder(deps,{storeRoot:root,durationMs:1000});
  try{assert.throws(()=>fs.readFileSync(path.join(root,'missing.json')),e=>e.code==='ENOENT');const replacement=()=>Buffer.alloc(0);fs.readFileSync=replacement;
    const result=probe.stop();assert.equal(result.events[0].failed,true);assert.equal(result.restored,false);assert.equal(fs.readFileSync,replacement);
  }finally{fs.readFileSync=original;syncBuiltinESMExports();probe.stop();}
});
test('startup watchdog restores owned state without the controller',async t=>{
  const {root,deps}=fixture(t),original=fs.readFileSync,probe=installStartupReadOrder(deps,{storeRoot:root,durationMs:100});
  await new Promise(resolve=>setTimeout(resolve,150));assert.equal(probe.peek().stopped,true);assert.equal(probe.peek().restored,true);assert.equal(fs.readFileSync,original);
});
test('failed ESM synchronization rolls back an incomplete installation',t=>{
  const {root,deps}=fixture(t),original=fs.readFileSync,error=new Error('fixture synchronization failure');
  assert.throws(()=>installStartupReadOrder({...deps,syncExports(){throw error;}},{storeRoot:root,durationMs:1000}),value=>value===error);
  assert.equal(fs.readFileSync,original);
});
test('deep startup caller survives a small global stack limit which is restored immediately',t=>{
  const {root,deps}=fixture(t),descriptor=Object.getOwnPropertyDescriptor(Error,'stackTraceLimit');
  const probe=installStartupReadOrder(deps,{storeRoot:root,durationMs:1000});
  try{
    Error.stackTraceLimit=2;
    function startupTop(){function nested(n){if(n)return nested(n-1);fs.readFileSync(path.join(root,'evidence-index.jsonl'));}nested(22);}
    startupTop();assert.equal(Error.stackTraceLimit,2);const row=probe.stop().events[0];assert.ok(row.stack.includes('startupTop'));assert.ok(row.stackFrames>20);assert.ok(row.stackFrames<64);
  }finally{probe.stop();Object.defineProperty(Error,'stackTraceLimit',descriptor);}
});
