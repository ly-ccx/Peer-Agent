import test from'node:test';import assert from'node:assert/strict';import{evaluateE3Checkpoint,qualifiedE3Fast,qualifiedE3FastPair,qualifiedE3Dense}from'./e3-checkpoint.mjs';
// Numeric gate fixtures only; no runtime delays or field-formation claim.
const row=(cost=260)=>({samplingSchema:'controlled-heap-v1',readKind:'dense',rows:23,planCalls:3859,sourceBefore:'same',sourceAfter:'same',outputSha256:'output',userMs:400,systemMs:0,processUserMs:410,processSystemMs:0,instrumentationCpuMs:.5,
 heapBefore:{spaces:[{space_name:'new_space',space_size:67108864}]},heapAfter:{spaces:[{space_name:'new_space',space_size:67108864}]},gc:{major:0,incremental:0},evidence:Array.from({length:12},()=>({rows:69266,userMs:cost/12}))});
const block=cost=>({points:Array.from({length:8},()=>({row:row(cost),pmc:{available:true,exclusiveWindow:true}})),calibration:Array.from({length:3},()=>({userMs:10,systemMs:0}))});
const checkpoint=(cost=260)=>({identity:'fixed-process-and-source',mainA:block(cost),reference:block(264),mainB:block(cost),sourceStable:true,expected:{sessions:23,planCalls:3859,evidenceRows:69266,outputSha256:'output'}});
test('the same target retains its first fast anchor, requires a second valid fast point and two slow checks',()=>{
 const f0=evaluateE3Checkpoint({},checkpoint()),f1=evaluateE3Checkpoint(f0.gate,checkpoint());assert.equal(qualifiedE3FastPair(f0,f1),true);
 const q1=evaluateE3Checkpoint(f1.gate,checkpoint(294)),q2=evaluateE3Checkpoint(q1.gate,checkpoint(294));assert.equal(q1.gate.status,'suspect');assert.equal(q2.gate.status,'confirmed-transition');assert.deepEqual(q2.gate.baseline,f0.gate.baseline);
});
test('armed state alone is not qualification when warm range, calibration, PMC or graph is invalid',()=>{
 const f0=evaluateE3Checkpoint({},checkpoint());for(const mutate of [c=>c.reference.points[7].row.evidence[0].userMs+=16,c=>c.mainA.calibration[0].userMs=c.mainA.calibration[1].userMs=c.mainA.calibration[2].userMs=20,c=>c.mainA.points[1].pmc.exclusiveWindow=false,c=>c.mainA.points[1].row.planCalls=0]){
  const c=checkpoint();mutate(c);const next=evaluateE3Checkpoint(f0.gate,c);assert.equal(qualifiedE3Fast(next),false);assert.equal(qualifiedE3FastPair(f0,next),false);
 }
});
test('heap-free witnesses cannot enter the old dense gate and first-point spikes remain excluded',()=>{
 const c=checkpoint();c.mainA.points[0].row.evidence[0].userMs+=100;assert.equal(qualifiedE3Fast(evaluateE3Checkpoint({},c)),true);
 c.mainA.points[1].row.samplingSchema='heap-free-witness-v1';c.mainA.points[1].row.heapBefore=null;const invalid=evaluateE3Checkpoint({},c);assert.equal(invalid.gate.status,'invalidated');assert.equal(qualifiedE3Fast(invalid),false);
});
test('an invalid source cannot borrow old compatible summaries to become a valid post-checkpoint',()=>{
 const f0=evaluateE3Checkpoint({},checkpoint()),c=checkpoint();c.mainA.points[1].row.sourceBefore='different';const bad=evaluateE3Checkpoint(f0.gate,c);assert.equal(bad.gate.status,'invalidated');assert.equal(qualifiedE3Dense(bad),false);
});
