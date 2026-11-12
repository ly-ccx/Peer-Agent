import test from'node:test';import assert from'node:assert/strict';import{runLongResidualWatch}from'./long-residual-watch.mjs';
const row=(extra=0)=>({origin:'natural',matches:true,sourceBefore:'same',sourceAfter:'same',outputSha256:'same',start:0,end:500,
  evidence:Array.from({length:12},()=>({rows:69266,userMs:25+extra,newSpaceBefore:67108864,newSpaceAfter:67108864,gc:{major:0,incremental:0}}))});
function fixture({natural=true,positive=false,budget=60000,changes=false,drift=true}={}){
 let now=0,reads=0,captures=0,renewals=0,roots=0;const events=[],report={};
 const io={now:()=>now,interrupted:()=>false,wait:async ms=>{now+=natural?Math.min(ms,1000):ms;},
  source:async()=>({sha256:changes?String(Math.floor(now/60000)):'source'}),archive:async()=>({consistent:true}),remainingReadCpuMs:()=>budget,
  checkpoint:async(state,source,label)=>{reads++;if(label.includes('trigger')||label.includes('confirm'))return {gate:positive?{baseline:[0,0],status:label.includes('confirm')?'confirmed-transition':'suspect'}:{baseline:[0,0],status:'armed'}};return {gate:{baseline:[0,0],status:'armed'}};},
  capture:async()=>{captures++;return {testOnly:true};},renew:async()=>{renewals++;},progress:(w,g,event)=>{if(event)events.push(event.kind);},
  collectIfDirty:async()=>{if(!natural)return null;roots++;const r=row(drift&&roots>5?2.5:0);r.start=now;r.end=now+500;return {rows:[r]};}};
 return {io,report,events,counts:()=>({reads,captures,renewals,roots})};
}
test('long idle observation never turns heartbeat into recurring business queries',async()=>{
 const f=fixture({natural:false});const r=await runLongResidualWatch({durationMs:7200000,...f,settleMs:0});
 assert.equal(f.counts().reads,1);assert.equal(f.counts().captures,0);assert.ok(f.counts().renewals>100);assert.equal(r.endReason,'bounded-deadline');assert.equal(r.phase,'learning');
});
test('a natural signal is followed by two unprofiled comparisons before candidate actions',async()=>{
 const f=fixture({positive:true});const r=await runLongResidualWatch({durationMs:600000,...f,settleMs:0});
 assert.equal(r.endReason,'transition-captured');assert.equal(r.generations[0].fingerprint.roots,5);assert.equal(f.counts().reads,4);assert.equal(f.counts().captures,1);
 assert.equal(r.episodes[0].initialStatus,'suspect');assert.equal(r.episodes[0].finalStatus,'confirmed-transition');assert.ok(f.events.indexOf('natural-fingerprint-armed')<f.events.indexOf('natural-trigger'));
});
test('false natural signals cannot consume more than three episodes or bypass a reserved CPU budget',async()=>{
 const f=fixture();await runLongResidualWatch({durationMs:2400000,...f,settleMs:0});assert.equal(f.counts().reads,8);assert.equal(f.counts().captures,3);
 const limited=fixture({budget:19000});const r=await runLongResidualWatch({durationMs:60000,...limited,settleMs:0});assert.equal(limited.counts().reads,0);assert.equal(r.phase,'passive-budget');
});
test('an unqualified entry fingerprint still preserves a natural event without claiming prior fast state',async()=>{
 const f=fixture();const original=f.io.checkpoint;
 f.io.checkpoint=async(state,source,label)=>label.includes('bootstrap')||label.includes('learning-bracket')?{gate:{status:'waiting-baseline',reason:'unmatched_gc_state_or_unstable_warm'}}:original(state,source,label);
 const r=await runLongResidualWatch({durationMs:100000,...f,settleMs:0});assert.equal(r.generations[0].fingerprint.fastBracketed,false);
 assert.equal(r.episodes[0].priorQualifiedFast,false);assert.equal(f.counts().captures,1);assert.notEqual(r.endReason,'transition-captured');
});
test('source changes freeze history and admit at most two independent data generations',async()=>{
 const f=fixture({changes:true,drift:false});const r=await runLongResidualWatch({durationMs:300000,...f,settleMs:0,stableSourceMs:0});
 assert.equal(r.generations.length,3);assert.ok(r.generations.every(g=>g.invalidated));assert.equal(r.phase,'waiting-stable-source');assert.equal(f.counts().captures,0);
});
