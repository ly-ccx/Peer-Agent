import fs from 'node:fs';
import assert from 'node:assert/strict';
import {cadenceHash as hash} from './ri00/e3-cadence-identity.mjs';
import {browserMainCounterDelta} from './ri00/thread-counter-delta.mjs';
import {evaluatePlacementTarget,evaluatePlacementCampaign} from './ri00/e3-calibration-placement-result.mjs';
const args=process.argv.slice(2),opt=k=>args[args.indexOf('--'+k)+1];
for(const k of ['report','journal','binding','budget','output'])if(!args.includes('--'+k))throw Error('placement_audit_inputs');
const read=k=>JSON.parse(fs.readFileSync(opt(k))),r=read('report'),binding=read('binding'),budget=read('budget'),
 records=fs.readFileSync(opt('journal'),'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
assert.equal(r.inputs.binding,hash(fs.readFileSync(opt('binding'))));assert.equal(binding.inputs.budget,hash(fs.readFileSync(opt('budget'))));
assert.equal(r.candidate,binding.candidate);assert.deepEqual(r.source,binding.source);
const roots=records.filter(x=>x.kind==='read-and-entry-batch'),hashes=records.filter(x=>x.kind==='hash-calibration'),attempts=records.filter(x=>x.kind==='hash-attempt');
assert.equal(roots.length,r.supervisorRoots);const byKey=new Map();
for(const entry of roots){const {host,value}=entry.value;assert.equal(value.batch.rows.length,1);const row=value.batch.rows[0],key=JSON.stringify([host,row.ticketId]);
 assert.equal(byKey.has(key),false);byKey.set(key,entry);
 const point=r.hosts.find(h=>h.label===host)?.points.find(p=>p.row.ticketId===row.ticketId);assert.ok(point);assert.deepEqual(point.row,row);
 assert.deepEqual(browserMainCounterDelta(value.before,value.after,r.counterRuntime.timebase,row.userMs+row.systemMs),point.pmc);
}
let blockCount=0;const checkedBlocks=[];
for(const target of r.targets)for(const cell of target.cells)for(const block of cell.executed){
 const boundary=block.controllerBoundary,start=records.find(x=>x.seq===boundary.startJournalSeq),end=records.find(x=>x.seq===boundary.endJournalSeq);
 assert.equal(start.kind,'complete-block-start');assert.equal(end.kind,'complete-block-end');assert.equal(start.value.label,block.label);assert.equal(end.value.label,block.label);
 const rows=block.sequence.map(p=>byKey.get(JSON.stringify([boundary.host,p.row.ticketId])));assert.ok(rows.every(Boolean));
 assert.deepEqual(end.value.tickets,block.sequence.map(p=>p.row.ticketId));
 const hs=hashes.filter(x=>x.value.host===boundary.host&&x.value.stage===block.label);assert.equal(hs.length,3);assert.deepEqual(hs.map(x=>x.value.value),block.calibration);
 for(let i=0;i<hs.length;i++){const h=hs[i],position=block.hashPositions[i].beforeReadIndex,at=attempts.find(x=>x.seq===h.value.attemptSeq);
  assert.ok(at&&at.seq<h.seq);assert.equal(at.value.host,boundary.host);assert.equal(h.value.position.beforeReadIndex,position);
  assert.ok(start.seq<at.seq&&h.seq<end.seq);assert.ok(!roots.some(x=>at.seq<x.seq&&x.seq<h.seq));
  if(position===null)assert.ok(rows[9].seq<at.seq);else assert.ok(rows[position-1].seq<at.seq&&h.seq<rows[position].seq);
 }
 checkedBlocks.push({target:target.label,arm:cell.arm,role:block.role,tickets:end.value.tickets,hashJournalSeq:hs.map(h=>h.seq),positions:block.hashPositions.map(h=>h.beforeReadIndex)});blockCount++;
}
for(const h of r.hosts){const init=hashes.filter(x=>x.value.host===h.label&&x.value.stage==='initialization'),hostRoots=roots.filter(x=>x.value.host===h.label);
 assert.equal(init.length,3);assert.deepEqual(init.map(x=>x.value.value),h.initialCalibration);assert.ok(init.every(x=>x.seq<hostRoots[0].seq));
 assert.deepEqual(h.nativeResponses.map(x=>x.value),hashes.filter(x=>x.value.host===h.label).map(x=>x.value.value));
 assert.equal(h.inspectorClosure.closed,true);assert.equal(h.closed.code,0);
}
for(const t of r.targets)assert.deepEqual(evaluatePlacementTarget(t,binding.expected),t.result);
const replay=evaluatePlacementCampaign(r.targets);for(const [k,v]of Object.entries(replay))assert.deepEqual(r[k],v,k);
assert.equal(r.executionCompleted,true);assert.equal(r.ownedLaunches,3);assert.equal(roots.length,184);assert.equal(blockCount,16);assert.equal(hashes.length,57);assert.equal(attempts.length,57);
assert.equal(r.failures.length,0);assert.equal(r.sourceUnchanged,true);assert.equal(r.driverUnchanged,true);assert.equal(r.unknownCostGap,false);
assert.ok(r.readCpuMs<=budget.readCpuMs&&r.hashCpuMs<=budget.hashCpuMs&&r.wallMs<=budget.formalWallMs&&r.totalActiveWallMs<=budget.totalActiveWallMs);
assert.equal(r.performanceQualified,false);assert.equal(r.f0AdmissionIssued,false);assert.equal(r.fieldWindowAllowed,false);
const result={kind:'HASH-PLACEMENT-raw-journal-position-gap-and-result-replay',candidate:r.candidate,inputSha256:hash(fs.readFileSync(opt('report'))),journalSha256:hash(fs.readFileSync(opt('journal'))),bindingSha256:hash(fs.readFileSync(opt('binding'))),
 roots:roots.length,blockCount,nativeCalls:hashes.length,checkedBlocks,replay,allRecordedFactsReplayed:true,performanceQualified:false,notFieldCause:true};
const fd=fs.openSync(opt('output'),'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(result));fs.fdatasyncSync(fd);}finally{fs.closeSync(fd);}
console.log(JSON.stringify({replayed:true,roots:roots.length,blockCount,nativeCalls:hashes.length,diagnosticOutcome:r.diagnosticOutcome}));
