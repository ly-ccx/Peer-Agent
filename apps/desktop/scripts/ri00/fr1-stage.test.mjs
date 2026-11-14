import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createFr1StageMeter} from './fr1-stage-meter.mjs';
import {fr1StageSource,fr1StageDeclaration} from './fr1-stage-source.mjs';
import {analyzeFr1Stages} from './fr1-stage-analysis.mjs';

function deterministic(owner='unit-stage',limits={}){
  let cpu=0,wall=0;
  return createFr1StageMeter({owner,...limits,clock:previous=>{const user=++cpu;return{user:user-(previous?.user??0),system:0};},monotonic:()=>wall+=.01});
}
function fixture({fail=false}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fr1-stage-unit-'));fs.writeFileSync(path.join(dir,'evidence-index.jsonl'),'{}');
  const meter=deterministic(),oldMeter=globalThis.__fr1StageMeter,oldChecks=globalThis.__fr1OwnedChecks;
  globalThis.__fr1StageMeter=meter;globalThis.__fr1OwnedChecks={unit:true};
  let reads=0;const error=Error('original-read'),result=[{id:'one'}],store={getStoreDir:()=>dir,getPlan:()=>({}),listEvidenceIndex:()=>[{}]};
  const supervisor={list(){reads++;for(let i=0;i<12;i++){store.getPlan();store.listEvidenceIndex();}if(fail)throw error;return result;}},original=supervisor.list;
  const application={list:()=>supervisor.list({workspaceId:'one'})};
  const install=Function('return ('+fr1StageSource().source+')')();
  const recorder=install({store,roots:[{object:supervisor,key:'list',kind:'list'}],entries:[{object:application,key:'list',kind:'fixture-entry',transport:true}],
    ownerId:'unit-stage',identityComplete:true,epoch:'unit',bounds:{rootSelfMs:0}});
  return{meter,recorder,supervisor,application,original,error,result,get reads(){return reads;},close(){recorder.stop();if(oldMeter===undefined)delete globalThis.__fr1StageMeter;else globalThis.__fr1StageMeter=oldMeter;if(oldChecks===undefined)delete globalThis.__fr1OwnedChecks;else globalThis.__fr1OwnedChecks=oldChecks;fs.rmSync(dir,{recursive:true,force:true});}};
}

test('source is fixed to original candidate and preserves both original hard gate predicates',()=>{
  const x=fr1StageSource();assert.equal(x.clockSites,8);assert.equal(x.seams.length,20);assert.equal(x.gateUnchanged,true);
  assert.ok(x.source.includes('if(totalSelf>cap.rootSelfMs)'));assert.ok(x.source.includes('rootSelfMs:2,selfMs:3000'));
  assert.ok(!x.source.includes('process.threadCpuUsage('));assert.doesNotThrow(()=>Function('return ('+x.source+')'));
  assert.throws(()=>fr1StageSource(x.source),/base_version/);assert.ok(fr1StageDeclaration().declaration.includes(x.source));
});
test('generated recorder refuses a process without its private owned marker',()=>{
  const original=globalThis.__fr1OwnedChecks;delete globalThis.__fr1OwnedChecks;
  try{assert.throws(()=>Function('return ('+fr1StageSource().source+')')()({store:{},roots:[{}],entries:[]}),/stage_owned_only/);}
  finally{if(original!==undefined)globalThis.__fr1OwnedChecks=original;}
});
test('actual transformed seams preserve output, query count, gate stop and owner recovery',async()=>{
  const f=fixture();try{assert.equal(f.application.list(),f.result);assert.equal(f.reads,1);assert.equal(f.recorder.state().stopReason,'per-root-probe-cpu-cap');assert.equal(f.supervisor.list,f.original);
    const batch=await f.recorder.take(),root=batch.records.find(x=>x.kind==='root').value;f.recorder.ack({throughSeq:batch.throughSeq});
    const meter=f.meter.freeze(),analysis=analyzeFr1Stages(meter,root,f.recorder.state());
    assert.equal(analysis.valid,true,analysis.errors.join(','));assert.equal(root.evidence.length,12);assert.equal(root.planCalls,12);assert.equal(meter.openStages.length,0);
    assert.equal(analysis.groups.find(x=>x.name==='stack.capture').count,13);assert.equal(analysis.groups.find(x=>x.name==='output.json').count,1);
    assert.equal(analysis.groups.find(x=>x.name==='span.pre').count,12);assert.ok(analysis.coverage.cpuRemainderMs>=0);
    const stacks=batch.records.filter(x=>x.kind==='stack');assert.ok(stacks.every(x=>x.value.frames.every(f=>!['begin','end','read'].includes(f[0]))));
    assert.equal(analysis.functionalQualification,false);assert.equal(analysis.fieldAdmission,false);
    assert.equal(f.meter.clockControl().pairs.length,64);assert.equal(f.recorder.state().retainedBytes,0);
  }finally{f.close();}
});
test('operation finally blocks preserve original thrown object and close all diagnostic stages',async()=>{
  const f=fixture({fail:true});try{assert.throws(()=>f.application.list(),e=>e===f.error);assert.equal(f.supervisor.list,f.original);
    const b=await f.recorder.take();assert.equal(b.records.find(x=>x.kind==='root').value.readFailure,true);assert.equal(f.meter.freeze().openStages.length,0);
  }finally{f.close();}
});
test('meter stops bookkeeping at caps without throwing into the original operation',()=>{
  const m=deterministic('bounded',{maxStages:1,maxClocks:3});m.begin('one');m.begin('two');assert.doesNotThrow(()=>m.end('one'));
  const s=m.freeze();assert.equal(s.invalid,'stage-cap');assert.ok(s.stages.length<=1);assert.ok(s.clocks.length<=3);assert.ok(s.openStages.length>0);
});
test('CPU bracket, operation wall and boundary observer bounds remain separate',()=>{
  const m=deterministic();m.begin('outer');m.begin('inner');m.end('inner');m.end('outer');const s=m.freeze();const a=analyzeFr1Stages(s,null,{}),outer=a.stages.find(x=>x.name==='outer'),inner=a.stages.find(x=>x.name==='inner');
  assert.equal(outer.cpuMs,.003);assert.equal(inner.cpuMs,.001);assert.ok(Math.abs(outer.exclusiveCpuMs-.002)<1e-10);
  assert.ok(outer.operationWallUpperMs>outer.cpuMs);assert.equal(outer.exactOperationCpu,false);assert.ok(a.errors.includes('root-missing'));
});
test('open or incoherent CPU windows are retained as invalid, not clamped into qualification',()=>{
  const m=deterministic();m.begin('unfinished');const open=m.freeze();assert.ok(analyzeFr1Stages(open,null,{}).errors.includes('open-stages'));
  const n=deterministic();n.begin('one');n.end('one');const s=n.freeze();s.stages[0].endUser+=1000000;
  const a=analyzeFr1Stages(s,null,{});assert.ok(a.errors.some(x=>x.startsWith('cpu-clock-coherence')));assert.ok(a.stages[0].cpuMs>900);
});
