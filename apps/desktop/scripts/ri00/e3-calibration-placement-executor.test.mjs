import test from 'node:test';
import assert from 'node:assert/strict';
import {calibrationPlacementPlan} from './e3-calibration-placement-plan.mjs';
import {executePlacementBlock,traceOrderBlock,runPlacementCampaign} from './e3-calibration-placement-controller.mjs';
import {placementBlockTiming,evaluatePlacementTarget,evaluatePlacementCampaign} from './e3-calibration-placement-result.mjs';
const expected={sessions:23,evidenceRows:69266,planCalls:3859,outputSha256:'output'};
function fixture({aRange=20,bRange=5,failReserve=false}={}) {
 let clock=0,seq=0,roots=0,hashes=0;const hosts=[],closed=[],journal=[],reserves=[];
 const now=()=>clock,append=(kind,value)=>{const r={seq:++seq,kind,value};journal.push(r);return r;};
 const native=()=>{const start=clock;clock+=22;hashes++;return {start,end:clock,userMs:22,systemMs:0};};
 function point(h,user=300,kind='dense'){
  const start=clock;clock+=user+130;roots++;
  const row={ticketId:++h.ticket,label:'cadence-root',samplingSchema:'controlled-heap-v1',readKind:kind,
   start,end:clock,userMs:user+100,systemMs:30,processUserMs:user+100,processSystemMs:30,
   sourceBefore:'same',sourceAfter:'same',rows:23,planCalls:3859,outputSha256:'output',instrumentationCpuMs:1,
   heapBefore:{spaces:[{space_name:'new_space',space_size:67108864}]},heapAfter:{spaces:[{space_name:'new_space',space_size:67108864}]},
   gc:{minor:12,major:0,incremental:0},evidence:Array.from({length:12},()=>({userMs:user/12,systemMs:.1,rows:69266,gc:{minor:1,major:0,incremental:0}}))};
  return {row,pmc:{available:true,exclusiveWindow:true,cpuMs:user+131,levels:[{name:'Performance',instructions:'8000000000',cycles:'1700000000',cpuMs:user+131}]}};
 }
 const io={open:async label=>{const h={label,ticket:0,record:{points:[]}};hosts.push(h);return h;},close:async h=>closed.push(h.label),
  initialize:async(h,n)=>{h.record.initialCalibration=Array.from({length:n},native);},warm:async(h,n)=>{for(let i=0;i<n;i++)h.record.points.push(point(h));},
  reserve:async({targetsRemaining})=>{reserves.push(targetsRemaining);if(failReserve)throw Error('reserve');return {admitted:true};},identity:async()=>true,checkpoint:async()=>{},
  block:async(h,spec,label)=>traceOrderBlock({journal:{append},host:h.label,spec,label,now,run:async()=>{
   let i=0;const range=spec.role==='target'?(spec.arm==='A'?aRange:bRange):5;
   const pattern=[0,0,-.5,-.4,-.2,0,.2,.4,.5,0];
   return executePlacementBlock({guard:()=>{},now,wait:async ms=>{clock+=ms;},calibrate:async()=>native(),
    read:async kind=>point(h,300+range*pattern[i++],kind)},spec,label);
  }})};
 return {io,hosts,closed,journal,reserves,get roots(){return roots;},get hashes(){return hashes;}};
}
const run=f=>runPlacementCampaign({io:f.io,expected,report:{targets:[]}});
test('fixed three hosts collect failed A, B and complete returns without issuing admission',async()=>{
 const f=fixture(),r=await run(f);assert.equal(f.roots,184);assert.equal(f.hashes,57);assert.equal(f.hosts.length,3);assert.equal(f.closed.length,3);
 assert.deepEqual(f.reserves,[2,1]);assert.equal(r.executionCompleted,true);assert.equal(r.diagnosticControlsValid,true);assert.equal(r.diagnosticOutcome,'supported');
 assert.equal(r.performanceQualified,false);assert.equal(r.f0AdmissionIssued,false);assert.equal(r.fieldWindowAllowed,false);
 for(const t of r.targets){assert.equal(t.cells.length,4);for(let i=0;i<4;i++){const p=t.result.originalPairs[i];assert.equal(p.checks.unchangedWarmGate,t.cells[i].arm==='B');}}
});
test('one existing 150ms window includes native work and placement stays outside roots',async()=>{
 const f=fixture(),r=await run(f),b=r.targets[0].cells[1].targetBlock;
 assert.deepEqual(b.hashPositions.map(h=>h.beforeReadIndex),[2,5,8]);assert.ok(b.waits.every(w=>w.actualMs===150));
 assert.equal(placementBlockTiming(b).valid,true);assert.ok(placementBlockTiming(b).gaps.gapsMs.every(g=>g===150));
 const a=r.targets[0].cells[0].targetBlock;assert.deepEqual(a.hashPositions.map(h=>h.beforeReadIndex),[null,null,null]);
});
test('bad baseline not reproduced and absent range effect remain distinct valid outcomes',async()=>{
 assert.equal((await run(fixture({aRange:10}))).diagnosticOutcome,'baseline-not-reproduced');
 assert.equal((await run(fixture({bRange:18}))).diagnosticOutcome,'hypothesis-not-supported');
});
test('position tampering, overlap and actual short gaps cannot qualify',async()=>{
 const r=await run(fixture());
 for(const mutate of [b=>b.hashPositions[0].beforeReadIndex=3,b=>{b.hashPositions[0].value.start=b.sequence[2].row.start;},
   b=>{b.sequence[2].row.start=b.sequence[1].row.end+149;}]){
  const t=structuredClone(r.targets[0]);mutate(t.cells[1].targetBlock);const v=evaluatePlacementTarget(t,expected);assert.equal(v.diagnosticControlsValid,false);
 }
});
test('raw target or conditioning drift cannot be hidden by normalized cancellation',async()=>{
 const r=await run(fixture()),t=r.targets[0];
 for(const b of t.cells[3].executed)for(const p of b.points)p.row.evidence[0].userMs+=2.1;
 const result=evaluatePlacementTarget(t,expected);assert.equal(result.checks.normalizedReturn,true);assert.equal(result.checks.rawTargetReturn,false);assert.equal(result.checks.rawConditioningReturn,false);
});
test('incomplete reservation and unknown native outcome stop without another process or retry',async()=>{
 const f=fixture({failReserve:true});await assert.rejects(run(f),/reserve/);assert.equal(f.hosts.length,2);assert.equal(f.roots,16);
 let attempts=0,reads=0,clock=0;
 await assert.rejects(executePlacementBlock({guard:()=>{},now:()=>clock,wait:async ms=>{clock+=ms;},read:async()=>{reads++;return {row:{}};},
  calibrate:async()=>{attempts++;throw Error('native-unknown');}},calibrationPlacementPlan().targets[0].cells[1].blocks[0],'unknown'),/native-unknown/);
 assert.equal(attempts,1);assert.equal(reads,2);assert.equal(evaluatePlacementCampaign([]).diagnosticOutcome,'invalid');
});

test('serialized projection replays the same diagnostic controls without relying on object identity',async()=>{const r=JSON.parse(JSON.stringify(await run(fixture())));for(const t of r.targets)assert.deepEqual(evaluatePlacementTarget(t,expected),t.result);});
