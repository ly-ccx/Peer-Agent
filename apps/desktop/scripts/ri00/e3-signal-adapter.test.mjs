import test from 'node:test';
import assert from 'node:assert/strict';
import { createE3SignalAdapter,e3NaturalIdentity } from './e3-signal-adapter.mjs';

// Numeric policy fixtures are not field-cause or latency injection evidence.
function row(n,extra=0){return {origin:'natural',matches:true,samplingSchema:'passive-cpu-v2',rootMethod:'list',start:60000+n*100,end:60000+n*100+50,
 sourceBefore:'stat',sourceAfter:'stat',outputSha256:'output',evidence:Array.from({length:12},()=>({rows:10,userMs:20+extra,gc:{major:1,incremental:1}}))};}
function ready(){const p=createE3SignalAdapter({epoch:'owned',startedMs:0,expectedIdentity:e3NaturalIdentity(row(1))});
 for(let i=0;i<5;i++)p.observe({rows:[row(i)],nowMs:61000+i});p.bracket({f0Qualified:true,f1QualifiedFast:true});return p;}
test('first five distinct full12 roots lock the baseline after quiet; GC positions stay included',()=>{
 const p=createE3SignalAdapter({epoch:'owned',startedMs:0,expectedIdentity:e3NaturalIdentity(row(1))});
 p.observe({rows:[{...row(1,50),start:1000,end:1050}],nowMs:1100});assert.equal(p.state().learningRoots,0);
 for(let i=2;i<7;i++)p.observe({rows:[row(i)],nowMs:61000+i});assert.equal(p.state().baseline.totalMs,240);
 p.observe({rows:[row(6,50)],nowMs:61010});assert.equal(p.state().baseline.totalMs,240);assert.equal(p.state().learningRoots,5);
});
test('a single full12 increase triggers, one-position marker alone does not, and busy does not launch',()=>{
 const p=ready(),single=row(10);single.evidence[4].userMs+=7;p.observe({rows:[single],nowMs:62000});
 assert.equal(p.claim(),null);assert.deepEqual(p.state().lastMarkers[0].positions,[4]);
 p.observe({rows:[row(11,1.1)],nowMs:63000});assert.equal(p.state().pending.reasons[0],'full12-user-cpu');
 assert.equal(p.claim({queueBusy:true}),null);const event=p.claim();assert.equal(event.notDenseResidualConfirmation,true);assert.equal(p.claim(),null);
 p.complete(event.id);p.observe({rows:[row(12,3)],nowMs:64000});assert.equal(p.claim(),null);
});
test('a new mapped entry signals without CPU increase and at most two distinct events are admitted',()=>{
 const p=ready();const entry=(kind,seq)=>({kind,seq,parentSeq:null,epoch:'owned',shapeDigest:'shape',portSequence:[{kind:'index',count:1}],end:1});
 p.observe({entries:[entry('ipc-list',1)],nowMs:62000});const first=p.claim();assert.equal(first.reasons[0],'new-mapped-exposure');p.complete(first.id);
 p.observe({entries:[entry('ipc-get',2)],nowMs:63000});const second=p.claim();p.complete(second.id);
 p.observe({entries:[entry('directory-list',3)],nowMs:64000});assert.equal(p.claim(),null);assert.equal(p.state().events,2);
});
test('a root Directory call stays a new exposure after the same nested Directory signature was seen',()=>{
 const p=createE3SignalAdapter({epoch:'owned',startedMs:0,expectedIdentity:e3NaturalIdentity(row(1))});
 const entry={kind:'directory-list',seq:2,parentSeq:1,epoch:'owned',shapeDigest:'shape',portSequence:[{kind:'index',count:12}],end:1};
 p.observe({entries:[entry],nowMs:1});for(let i=0;i<5;i++)p.observe({rows:[row(i)],nowMs:61000+i});p.bracket({f0Qualified:true,f1QualifiedFast:true});
 p.observe({entries:[{...entry,seq:3,parentSeq:null}],nowMs:62000});assert.equal(p.claim().reasons[0],'new-mapped-exposure');
 const q=ready();q.observe({entries:[{...entry,parentSeq:99}],nowMs:62000});assert.equal(q.state().reason,'entry-parent-chain-invalid');
});
test('overlap cannot train or trigger; source/graph change seals instead of relearning',()=>{
 const p=ready(),slow=row(10,3);p.observe({rows:[slow],nowMs:62000,diagnosticSpans:[{start:slow.start,end:slow.end}]});assert.equal(p.claim(),null);
 p.observe({rows:[{...row(11),outputSha256:'changed'}],nowMs:63000});assert.equal(p.state().reason,'natural-input-output-changed');assert.equal(p.state().baseline.totalMs,240);
 const q=ready();q.observe({sourceEpoch:'changed',nowMs:62000});assert.equal(q.state().reason,'source-epoch-changed');
});
test('multi-second wall emits only a signal and no-new-exposure has an eight-minute bound',()=>{
 const p=ready(),pause=row(10);pause.end=pause.start+2000;p.observe({rows:[pause],nowMs:64000});assert.equal(p.claim().reasons[0],'multi-second-wall');
 const q=ready();q.observe({nowMs:480000});assert.equal(q.state().stopped,false);q.observe({nowMs:541004});assert.equal(q.state().reason,'no-new-exposure-coverage');
});
test('late delivery cannot turn a pre-quiet root into baseline and returned snapshots cannot mutate the owner',()=>{
 const p=createE3SignalAdapter({epoch:'owned',startedMs:0,expectedIdentity:e3NaturalIdentity(row(1))});
 p.observe({rows:[{...row(1),start:59999,end:60001}],nowMs:61000});assert.equal(p.state().learningRoots,0);
 const q=ready(),snapshot=q.state();snapshot.baseline.totalMs=0;assert.equal(q.state().baseline.totalMs,240);
 const bad=ready();bad.observe({rows:[{...row(10),end:999999}],nowMs:62000});assert.equal(bad.state().reason,'natural-clock-invalid');
});
