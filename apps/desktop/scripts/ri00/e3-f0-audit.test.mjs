import test from 'node:test';
import assert from 'node:assert/strict';
import { auditE3F0 } from './e3-f0-audit.mjs';

function fixture() {
  const point = i => ({ row: { userMs: 200+i, systemMs: 10, processUserMs: 200+i, processSystemMs: 10,
    start: i*500, end: i*500+300, gc: {major:0,incremental:0,minor:i%2?12:11,observedOverlapMs:80},
    heapBefore:{used:100,spaces:[{space_name:'new_space',space_size:67108864,space_used_size:100}]},
    heapAfter:{spaces:[{space_name:'new_space',space_size:67108864}]},instrumentationCpuMs:.5,
    evidence:Array.from({length:12},()=>({userMs:10+i,systemMs:0,gc:{minor:1,observedOverlapMs:5}})) },
    pmc: {available:true,exclusiveWindow:true,levels:[{name:'Performance',instructions:'1000000',cycles:'3000000',cpuMs:210+i},{name:'Efficiency',instructions:'0',cycles:'0',cpuMs:0}]} });
  const block = ()=>({points:Array.from({length:8},(_,i)=>point(i))});
  return {targets:[{label:'fixed',checkpoints:[{label:'F0',mainA:block(),reference:block(),mainB:block(),calibrationStable:true}]}]};
}
test('sealed accounting retains every point, excludes first only in original gate and never subtracts GC wall',()=>{
  const input=fixture(),before=JSON.stringify(input),out=auditE3F0(input);
  assert.equal(JSON.stringify(input),before);assert.equal(out.totals.points,24);assert.equal(out.totals.compatible,21);
  assert.equal(out.blocks[0].points[1].evidenceUserMs,132);assert.equal(out.blocks[0].original.compatibleRange,72);
  assert.equal(out.blocks[0].extremes.evidenceUserDeltaMs,72);assert.equal(out.totals.strataStillOver15ms.length,6);
});
test('major/incremental, other-thread CPU and heap mismatch remain separate recorded rejections',()=>{
  const input=fixture(),p=input.targets[0].checkpoints[0].mainA.points;
  p[1].row.gc.major=1;p[2].row.processUserMs+=120;p[3].row.heapAfter.spaces[0].space_size=33554432;
  const out=auditE3F0(input),rows=out.blocks[0].points;
  assert.deepEqual(rows[1].rejectedBy,['observed-major-or-incremental']);assert.deepEqual(rows[2].rejectedBy,['other-thread-cpu']);
  assert.deepEqual(rows[3].rejectedBy,['new-space-size']);assert.equal(out.totals.rejectedWarm,3);
});
test('missing or nonexclusive points reject the audit instead of being dropped',()=>{
  const input=fixture();input.targets[0].checkpoints[0].mainA.points[1].pmc.exclusiveWindow=false;
  assert.throws(()=>auditE3F0(input),/invalid_point/);delete input.targets[0].checkpoints[0];
  assert.throws(()=>auditE3F0(input),/missing_checkpoint/);
});
