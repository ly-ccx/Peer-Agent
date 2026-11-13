import test from 'node:test';import assert from 'node:assert/strict';import {evaluateE3DrainTarget} from './e3-drain-result.mjs';
// Numeric qualification fixtures only: no host latency or cause is manufactured.
const cp=mode=>({mode,validation:{source:true,pmc:true,graph:true},calibrationStable:true,gate:{status:mode==='block'?'armed':'waiting-baseline',reason:mode==='block'?'criterion_not_met':'unmatched_gc_state_or_unstable_warm',
 deltas:[0,0],summaries:Array.from({length:3},()=>({compatible:5,compatibleRange:mode==='block'?10:20,median:200}))}});
const plan=()=>['point','block','block','point'].map(cp);
test('the frozen return contrast requires two point failures, two qualified block fasts and five ms improvement',()=>{
 assert.equal(evaluateE3DrainTarget(plan()).supported,true);const p=plan();p[0].gate.summaries.forEach(s=>s.compatibleRange=14);assert.equal(evaluateE3DrainTarget(p).supported,false);
});
test('calibration, current source validation and incompatible B points cannot borrow old summaries',()=>{
 for(const mutate of[p=>p[0].calibrationStable=false,p=>p[1].validation.source=false,p=>p[2].gate.summaries[0].compatible=2]){const p=plan();mutate(p);assert.equal(evaluateE3DrainTarget(p).supported,false);}
});
test('extra, missing or reordered checkpoints reject instead of selecting a passing subset',()=>{
 assert.throws(()=>evaluateE3DrainTarget(plan().slice(1)),/fixed_schedule/);assert.throws(()=>evaluateE3DrainTarget(['point','block','point','block'].map(cp)),/fixed_schedule/);
 assert.equal(evaluateE3DrainTarget(['block','point','point','block'].map(cp)).supported,true);
});
