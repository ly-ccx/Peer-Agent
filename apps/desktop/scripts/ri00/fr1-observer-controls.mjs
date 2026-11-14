import assert from 'node:assert/strict';
import {getCallSites} from 'node:util';
import {createHash} from 'node:crypto';
import {createFr1StageMeter} from './fr1-stage-meter.mjs';
import {reconcileFr1SelfWindows} from './fr1-stage-replay.mjs';

export function fr1MetadataEvents(meter,root,state){
  const windows=reconcileFr1SelfWindows(meter,root,state).windows;
  const stages=meter.stages.filter(x=>x.rootId===root.id),events=[];
  for(const c of meter.clocks){
    const begin=stages.find(s=>s.beginClockId===c.id),end=stages.find(s=>s.endClockId===c.id);
    if(begin)events.push({kind:'begin',name:begin.name,span:begin.spanPosition});
    else if(end)events.push({kind:'end',name:end.name});
    else if(c.role.startsWith('original-')&&windows.some(w=>c.id>=w.startClockId&&c.id<=w.endClockId)){
      assert.ok(['original-1','original-2','original-7','original-8'].includes(c.role));
      events.push({kind:'clock',site:Number(c.role.split('-')[1]),isDelta:c.isDelta});
    }
  }
  assert.equal(events.filter(e=>e.kind==='begin').length,121);
  assert.equal(events.filter(e=>e.kind==='clock').length,55);
  const stack=[];for(const e of events){if(e.kind==='begin')stack.push(e.name);else if(e.kind==='end')assert.equal(stack.pop(),e.name);}assert.equal(stack.length,0);
  return events;
}

export function fr1CellFailure(row,budget){
  if(row.cpuMs>budget.cellCpuMsMaximum)return'cell-cpu-cap';
  if(row.wallMs>budget.cellWallMsMaximum)return'cell-wall-cap';
  if(row.userUs<0||row.systemUs<0)return'cpu-regression';
  if(row.cpuMs>row.wallMs+.004)return'cpu-wall-incoherent';
  return null;
}

/** Owned diagnostic operations only. No store port, recorder installation or Inspector API. */
export async function runFr1ObserverControls({value,events,budget,expected,onCell,admit=()=>true,
  clock=process.threadCpuUsage.bind(process),now=performance.now.bind(performance),yieldTurn=()=>new Promise(setImmediate)}){
  const hash=v=>createHash('sha256').update(v).digest('hex'),rows=[];
  const totalWall=now(),totalCpu=clock();let previousEnd=null,stackSignature=null,stopReason=null;
  function captureAtDepth(n){return n?captureAtDepth(n-1):getCallSites(96,{sourceMap:false});}
  function operate(family,meter){
    if(family==='metadata-topology'){
      let previous;
      for(const e of events){
        if(e.kind==='begin'){if(meter)meter.begin(e.name,1,e.span);}
        else if(e.kind==='end'){if(meter)meter.end(e.name);}
        else{
          const p=e.isDelta?previous:undefined;
          if(e.isDelta&&!p)throw Error('control_delta_without_start');
          const v=meter?meter.originalClock(p,e.site):process.threadCpuUsage(p);
          if(e.site===7)previous=v;
        }
      }
      return null;
    }
    if(family==='stack.capture'){
      const captures=[];
      for(let i=0;i<budget.stackCapturesPerCell;i++){
        let sites;if(meter)meter.begin('stack.capture',1);
        try{sites=captureAtDepth(budget.stackRecursionDepth);}finally{if(meter)meter.end('stack.capture');}
        captures.push(sites);
      }
      return captures;
    }
    let text,bytes,digest;
    if(meter)meter.begin('output.json',1);
    try{text=JSON.stringify(value instanceof Map?[...value]:value);}finally{if(meter)meter.end('output.json');}
    if(meter)meter.begin('output.utf8',1);
    try{bytes=Buffer.from(text);}finally{if(meter)meter.end('output.utf8');}
    if(meter)meter.begin('hash.output',1);
    try{digest=hash(bytes);}finally{if(meter)meter.end('hash.output');}
    return{bytes,digest};
  }
  for(const family of budget.families){
    for(const [slot,arm]of budget.sequencePerFamily.entries()){
      await yieldTurn();
      const admissionCpu=clock();
      if((admissionCpu.user-totalCpu.user+admissionCpu.system-totalCpu.system)/1000>budget.allControlsCpuMsMaximum){stopReason='controls-cpu-cap';break;}
      if(now()-totalWall>budget.allControlsWallMsMaximum){stopReason='controls-wall-cap';break;}
      if(!admit()){stopReason='admission-deadline';break;}
      const meter=arm==='B'?createFr1StageMeter({owner:'owned-control',maxStages:budget.stageRowsMaximumPerCell,maxClocks:budget.clockRowsMaximumPerCell}):null;
      const wallStart=now(),a=clock();let result,operationError;
      try{result=operate(family,meter);}catch(e){operationError=e.message;}
      const b=clock(),wallEnd=now(),userUs=b.user-a.user,systemUs=b.system-a.system;
      const row={family,slot,arm,userUs,systemUs,cpuMs:(userUs+systemUs)/1000,wallMs:wallEnd-wallStart,
        startWall:wallStart,endWall:wallEnd,actualGapMs:previousEnd===null?null:wallStart-previousEnd,
        outerCpuIncludesMeasurement:true,exactOperationCpu:false,meter:meter?.freeze()??null,operationError:operationError??null};
      previousEnd=wallEnd;rows.push(row);
      stopReason=operationError?'operation-error':fr1CellFailure(row,budget);
      try{
        if(row.meter){assert.equal(row.meter.invalid,null);assert.deepEqual(row.meter.openStages,[]);
          const count=family==='metadata-topology'?budget.topologyStagesPerOnCell:family==='stack.capture'?budget.stackCapturesPerCell:3;
          assert.equal(row.meter.stages.length,count);assert.equal(row.meter.clocks.length,family==='metadata-topology'?budget.topologyClocksPerOnCell:count*2);}
        if(!operationError&&family==='stack.capture'){
          const vectors=result.map(sites=>sites.map(f=>[f.functionName,f.scriptId,f.scriptName,f.lineNumber,f.columnNumber]));
          const signature=JSON.stringify(vectors[0]);assert.ok(vectors[0].length<96);assert.ok(vectors[0].length>=budget.stackRecursionDepth);
          assert.ok(vectors.every(x=>JSON.stringify(x)===signature));stackSignature??=signature;assert.equal(signature,stackSignature);
          row.stack={captures:vectors.length,frames:vectors[0],sha256:hash(signature),allCompleteVectorsEqual:true};
        }
        if(!operationError&&family==='output.encoding'){
          assert.equal(result.bytes.length,expected.outputBytes);assert.equal(result.digest,expected.outputSha256);
          row.output={bytes:result.bytes.length,sha256:result.digest};
        }
      }catch(e){row.validationError=e.message;stopReason??='validation-error';}
      const cumulative=clock();row.controlCpuThroughValidationMs=(cumulative.user-totalCpu.user+cumulative.system-totalCpu.system)/1000;
      row.controlWallThroughValidationMs=now()-totalWall;
      if(row.controlCpuThroughValidationMs>budget.allControlsCpuMsMaximum)stopReason??='controls-cpu-cap';
      if(row.controlWallThroughValidationMs>budget.allControlsWallMsMaximum)stopReason??='controls-wall-cap';
      row.stopReason=stopReason;await onCell(row);
      // Stop before any later operation, including in the next family. No warmup or retry path.
      if(stopReason)break;
    }
    if(stopReason)break;
  }
  const last=clock(),cpuMs=(last.user-totalCpu.user+last.system-totalCpu.system)/1000,wallMs=now()-totalWall;
  if(cpuMs>budget.allControlsCpuMsMaximum)stopReason??='controls-cpu-cap';if(wallMs>budget.allControlsWallMsMaximum)stopReason??='controls-wall-cap';
  const contrasts=budget.families.flatMap(family=>[0,1].map(block=>{
    const xs=rows.filter(x=>x.family===family&&Math.floor(x.slot/4)===block);if(xs.length!==4)return{family,block,complete:false};
    const mean=(arm,key)=>{const rs=xs.filter(x=>x.arm===arm);return rs.reduce((s,x)=>s+x[key],0)/rs.length;};
    const as=xs.filter(x=>x.arm==='A');return{family,block,complete:true,bMinusAUserUs:mean('B','userUs')-mean('A','userUs'),
      bMinusASystemUs:mean('B','systemUs')-mean('A','systemUs'),bMinusACpuMs:mean('B','cpuMs')-mean('A','cpuMs'),
      aReturnDriftCpuMs:as[1].cpuMs-as[0].cpuMs,noHistoricalOrGateSubtraction:true};
  }));
  return{rows,contrasts,stopReason,cpuMs,wallMs,completed:!stopReason&&rows.length===budget.families.length*budget.sequencePerFamily.length,
    functionalQualification:false,fieldAdmission:false,originalRecorderGateEvaluated:false};
}
