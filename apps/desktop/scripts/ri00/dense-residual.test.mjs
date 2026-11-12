import test from 'node:test';
import assert from 'node:assert/strict';
import {advanceDenseResidual} from './dense-residual.mjs';
const rows=(extra=0)=>Array.from({length:8},(_,i)=>({userMs:370+extra,systemMs:30,processUserMs:440+extra,processSystemMs:30,
  sourceBefore:'stamp',sourceAfter:'stamp',outputSha256:'facts',heapBefore:{spaces:[{space_name:'new_space',space_size:67108864}]},
  heapAfter:{spaces:[{space_name:'new_space',space_size:67108864}]},gc:{major:0,incremental:0},evidence:Array.from({length:12},()=>({rows:69266,userMs:22.5+(i===0?100:extra)/12}))}));
const point=(extra=0)=>({identity:'same-main/start+same-reference/start+same-source',valid:true,mainA:rows(extra),reference:rows(),mainB:rows(extra)});
test('one process needs a fast baseline and two persistent warm residual checkpoints',()=>{
  let s=advanceDenseResidual({},point());assert.equal(s.status,'armed');
  s=advanceDenseResidual(s,point(30));assert.equal(s.status,'suspect');assert.deepEqual(s.deltas,[30,30]);
  s=advanceDenseResidual(s,point(32));assert.equal(s.status,'confirmed-transition');
});
test('cold first reads, one spike and GC-incompatible warm work cannot confirm the dense residual',()=>{
  let s=advanceDenseResidual({},point());assert.equal(s.status,'armed');
  const spike=point();spike.mainA[4].evidence.forEach(e=>e.userMs+=20);assert.equal(advanceDenseResidual(s,spike).status,'armed');
  const gc=point(30);for(const r of gc.mainA.slice(1))r.gc.major=1;
  const rejected=advanceDenseResidual(s,gc);assert.equal(rejected.status,'armed');assert.match(rejected.reason,/unmatched/);
  assert.equal(advanceDenseResidual({},point(35)).status,'slow-at-entry');
});
test('input, source, process and reference changes invalidate temporal comparison',()=>{
  const s=advanceDenseResidual({},point()),changed=point(35);changed.identity='replacement-reference';assert.equal(advanceDenseResidual(s,changed).status,'invalidated');
  const output=point(35);output.mainB[5].outputSha256='other-facts';assert.equal(advanceDenseResidual(s,output).status,'invalidated');
  const data=point(35);data.reference[3].evidence[0].rows++;assert.equal(advanceDenseResidual(s,data).status,'invalidated');
});
test('a faster main is a baseline, while calibration drift or only one slow block is inconclusive',()=>{
  assert.equal(advanceDenseResidual({},point(-30)).status,'armed');
  const mixed=point();mixed.mainA=rows(35);assert.equal(advanceDenseResidual({},mixed).status,'waiting-baseline');
  const s=advanceDenseResidual({},point()),changed=point(35);changed.calibrationStable=false;assert.equal(advanceDenseResidual(s,changed).status,'armed');
});
