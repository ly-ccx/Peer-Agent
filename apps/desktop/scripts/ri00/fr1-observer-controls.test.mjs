import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fr1CellFailure,runFr1ObserverControls} from './fr1-observer-controls.mjs';

const budget={families:['metadata-topology','output.encoding'],sequencePerFamily:['A','B','B','A','B','A','A','B'],
  cellCpuMsMaximum:2,cellWallMsMaximum:100,allControlsCpuMsMaximum:50,allControlsWallMsMaximum:1000,
  stageRowsMaximumPerCell:512,clockRowsMaximumPerCell:2048,topologyStagesPerOnCell:0,topologyClocksPerOnCell:0};
test('2ms is strict and wall is not substituted for CPU',()=>{
  assert.equal(fr1CellFailure({cpuMs:2,wallMs:2,userUs:1800,systemUs:200},budget),null);
  assert.equal(fr1CellFailure({cpuMs:2.001,wallMs:10,userUs:1801,systemUs:200},budget),'cell-cpu-cap');
  assert.equal(fr1CellFailure({cpuMs:.1,wallMs:101,userUs:100,systemUs:0},budget),'cell-wall-cap');
});
test('first failure is saved and stops later slots and families without retry',async()=>{
  let ticks=0,saved=0;const r=await runFr1ObserverControls({value:null,events:[],budget,expected:{},
    clock:()=>({user:(ticks++)*2001,system:0}),yieldTurn:async()=>{},onCell:()=>{saved++;}});
  assert.equal(r.stopReason,'cell-cpu-cap');assert.equal(r.rows.length,1);assert.equal(saved,1);
  assert.equal(r.rows[0].arm,'A');assert.equal(r.functionalQualification,false);assert.equal(r.originalRecorderGateEvaluated,false);
});
test('same output bytes and SHA are verified with and without meter; this is behavior, not Node timing',async()=>{
  const value=[{text:'中文🙂',n:3}],bytes=Buffer.from(JSON.stringify(value)),expected={outputBytes:bytes.length,outputSha256:createHash('sha256').update(bytes).digest('hex')};
  const r=await runFr1ObserverControls({value,events:[],budget:{...budget,families:['output.encoding']},expected,
    clock:()=>({user:0,system:0}),yieldTurn:async()=>{},onCell:()=>{}});
  assert.equal(r.completed,true);assert.equal(r.rows.length,8);assert.equal(r.rows[1].meter.stages.length,3);
  assert.ok(r.rows.every(x=>x.output.sha256===expected.outputSha256));assert.equal(r.fieldAdmission,false);
});
test('mismatch is preserved, never normalized to pass',async()=>{
  const r=await runFr1ObserverControls({value:[],events:[],budget:{...budget,families:['output.encoding']},expected:{outputBytes:2,outputSha256:'wrong'},
    clock:()=>({user:0,system:0}),yieldTurn:async()=>{},onCell:()=>{}});
  assert.equal(r.rows.length,1);assert.equal(r.stopReason,'validation-error');assert.ok(r.rows[0].validationError);
});
