import test from 'node:test';import assert from 'node:assert/strict';
import{learnNaturalFingerprint,advanceNaturalSentinel}from'./natural-residual.mjs';
const row=(extra=0)=>({origin:'natural',matches:true,sourceBefore:'same',sourceAfter:'same',outputSha256:'same',start:0,end:500,
 evidence:Array.from({length:12},()=>({rows:69266,userMs:25+extra,newSpaceBefore:67108864,newSpaceAfter:67108864,gc:{major:0,incremental:0}}))});
test('natural sentinel needs same-position learning and three sustained signals, never confirms dense CPU',()=>{
 assert.equal(learnNaturalFingerprint(Array.from({length:4},()=>row())),null);const f=learnNaturalFingerprint(Array.from({length:5},()=>row()));assert.equal(f.positions.length,12);
 let s={};for(let i=0;i<3;i++)s=advanceNaturalSentinel(s,f,row(2.5),i*15000);assert.equal(s.trigger,true);assert.equal(s.notDenseResidualConfirmation,true);assert.equal(s.episodes,1);
 assert.equal(advanceNaturalSentinel(s,f,row(2.5),60000).reason,'natural_cooldown');
 assert.equal(advanceNaturalSentinel({...s,episodes:3},f,row(2.5),1000000).reason,'natural_episode_budget_exhausted');
});
test('GC inside other spans does not erase eligible positions; mismatches break streak and large pauses only trigger',()=>{
 const base=Array.from({length:5},()=>row());for(const r of base)for(let i=0;i<6;i++)r.evidence[i].gc.major=1;
 const f=learnNaturalFingerprint(base);assert.equal(f.positions.length,6);
 const one=row(2.5);one.evidence[6].gc.incremental=1;assert.equal(advanceNaturalSentinel({},f,one,0).reason,'natural_gc_state_unmatched');
 const changed=row(2.5);changed.outputSha256='different';assert.equal(advanceNaturalSentinel({streak:2},f,changed,0).streak,0);
 const pause=row();pause.end=2500;const s=advanceNaturalSentinel({},f,pause,0);assert.equal(s.trigger,true);assert.equal(s.reason,'natural_multi_second');
 assert.equal(learnNaturalFingerprint([...base,changed]),null);
});
