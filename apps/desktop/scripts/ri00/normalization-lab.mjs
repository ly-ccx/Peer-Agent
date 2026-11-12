import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { performance, PerformanceObserver } from 'node:perf_hooks';
import * as v8 from 'node:v8';
import { Session } from 'node:inspector';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as timers from 'node:timers';
import { syncBuiltinESMExports } from 'node:module';
import { installObservation } from './live-observation.mjs';
import { guardReadOnlySource } from './readonly-coordination.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const wait = ms => new Promise(resolve => setTimeout(resolve,ms));
export function digestRows(rows) {
  const digest=createHash('sha256');
  for(const row of rows) digest.update(JSON.stringify(row)+'\n');
  return digest.digest('hex');
}
export function intersectMs(start,end,events) {
  return events.reduce((sum,e)=>sum+Math.max(0,Math.min(end,e.start+e.duration)-Math.max(start,e.start)),0);
}
export function median(values) {
  if(!values.length)return null;
  const sorted=[...values].sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);
  return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;
}
const calibrationBytes=Buffer.alloc(4*1024*1024,0x5a);
function calibration() {
  let value=0;
  for(let i=0;i<4;i++)value^=createHash('sha256').update(calibrationBytes).digest().readUInt32LE(0);
  return value;
}
function cpuElapsed(before) {
  const after=process.threadCpuUsage();
  return {userMs:(after.user-before.user)/1000,systemMs:(after.system-before.system)/1000};
}

/** Isolated child only: fixed raw records, unchanged production functions, no execution host. */
export async function runNormalizationLab(config) {
  if(typeof process.threadCpuUsage!=='function')throw new Error('thread_cpu_observation_required');
  process.env.PEER_AGENT_HOME=config.fixtureRoot;
  process.env.PEER_AGENT_SLOW_TIMER_MS='0';
  const guard=guardReadOnlySource(['goal-plans','conversations','projects'].map(name=>path.join(config.fixtureRoot,name)));
  const runtimeRoot=config.layout==='installed'
    ?path.join(config.installedRoot,'node_modules/@peer-agent/runtime-node')
    :path.join(config.moduleRoot,'packages/runtime-node');
  const file=path.join(config.fixtureRoot,'goal-plans/evidence-index.jsonl');
  const inputHash=hash(fs.readFileSync(file));
  const moduleFile=path.join(runtimeRoot,'dist/goal-plan-files.mjs');
  const {readJsonl,normalizeEvidenceIndexRecord,retainInteractiveEvidence}=await import(pathToFileURL(moduleFile).href);
  const records=readJsonl(file),rawDigest=digestRows(records);
  const normalize=()=>retainInteractiveEvidence(records.map(normalizeEvidenceIndexRecord).filter(Boolean));
  let invoke=normalize,observation,session,host,retained=[];
  const post=(method,params={})=>new Promise((resolve,reject)=>session.post(method,params,(error,result)=>error?reject(error):resolve(result)));
  const report={kind:'isolated-normalization-trigger-experiment',layout:config.layout,factor:config.factor,
    replicate:config.replicate,startedAt:new Date().toISOString(),inputSha256:inputHash,rawDigest,rawRows:records.length,
    moduleSha256:hash(fs.readFileSync(moduleFile)),functionSha256:{normalize:hash(normalizeEvidenceIndexRecord.toString()),retain:hash(retainInteractiveEvidence.toString())},
    runtime:{electron:process.versions.electron,node:process.versions.node,arch:process.arch,cachedDataVersionTag:v8.cachedDataVersionTag(),cpuMetric:'process.threadCpuUsage',calibration:'native-SHA256-16MiB'},
    phases:[],gc:[],failures:[],intervention:{},restoration:{}};
  const observer=new PerformanceObserver(list=>{
    for(const entry of list.getEntries())report.gc.push({start:entry.startTime,duration:entry.duration,kind:entry.detail?.kind});
  });
  observer.observe({entryTypes:['gc']});
  function heap(){const h=v8.getHeapStatistics();return {used:h.used_heap_size,total:h.total_heap_size,external:h.external_memory,code:v8.getHeapCodeStatistics()};}
  const expected=digestRows(normalize());
  function sampleRead(){
    const start=performance.now(),thread=process.threadCpuUsage(),output=invoke();
    return {start,end:performance.now(),...cpuElapsed(thread),rows:output.length};
  }
  async function phase(name) {
    const result={name,startedAt:new Date().toISOString(),heapBefore:heap(),transitionReads:[],batches:[]};
    for(let i=0;i<12;i++)result.transitionReads.push(sampleRead());
    for(let i=0;i<config.warmReads;i++)invoke();
    for(let i=0;i<3;i++)calibration();
    for(let batch=0;batch<config.batches;batch++) {
      const controlCpu=process.threadCpuUsage(),controlStart=performance.now(),value=calibration();
      const control={start:controlStart,end:performance.now(),wallMs:performance.now()-controlStart,...cpuElapsed(controlCpu),value};
      const row={batch,control,reads:[],start:performance.now()},cpu=process.threadCpuUsage();
      for(let read=0;read<config.readsPerBatch;read++) {
        row.reads.push(sampleRead());
      }
      row.end=performance.now();Object.assign(row,cpuElapsed(cpu));result.batches.push(row);
      await wait(20);
    }
    result.heapAfter=heap();result.outputDigest=digestRows(normalize());
    result.semanticMatch=result.outputDigest===expected;result.rawUnchanged=digestRows(records)===rawDigest;
    if(!result.semanticMatch||!result.rawUnchanged)throw new Error('normalization_input_or_output_changed');
    report.phases.push(result);
  }
  async function inspectScopes() {
    globalThis.__ri00NormalizationFunction=normalizeEvidenceIndexRecord;
    const reply=await post('Runtime.evaluate',{expression:'globalThis.__ri00NormalizationFunction',objectGroup:'ri00-lab-scopes'});
    let functions=0,scopes=0;
    const refs=[reply.result.objectId],seen=new Set();
    while(refs.length&&functions<32) {
      const id=refs.pop();if(seen.has(id))continue;seen.add(id);functions++;
      const props=await post('Runtime.getProperties',{objectId:id,ownProperties:true});
      const scope=props.internalProperties?.find(x=>x.name==='[[Scopes]]')?.value.objectId;if(!scope)continue;
      const list=await post('Runtime.getProperties',{objectId:scope,ownProperties:true});
      for(const entry of list.result) {
        if(!/^\d+$/.test(entry.name)||!entry.value?.objectId)continue;
        const bindings=await post('Runtime.getProperties',{objectId:entry.value.objectId,ownProperties:true});scopes++;
        for(const binding of bindings.result)if(binding.value?.type==='function'&&binding.value.objectId&&functions+refs.length<32)refs.push(binding.value.objectId);
      }
    }
    delete globalThis.__ri00NormalizationFunction;
    await post('Runtime.releaseObjectGroup',{objectGroup:'ri00-lab-scopes'});
    return {functions,scopes};
  }
  try {
    await phase('before');
    const started=performance.now();report.intervention.heapBefore=heap();
    if(config.factor==='sham')await wait(100);
    else if(config.factor==='dictionary-shapes'||config.factor==='frozen-shapes') {
      const variants=records.slice(0,2048).map(record=>{
        const value={...record};
        if(config.factor==='frozen-shapes')return Object.freeze(value);
        for(let i=0;i<40;i++)value[`ri00_unused_${i}`]=i;
        for(let i=0;i<40;i++)delete value[`ri00_unused_${i}`];
        return value;
      });
      for(let round=0;round<20;round++)for(const value of variants)normalizeEvidenceIndexRecord(value);
      report.intervention.variantCalls=variants.length*20;
    } else if(config.factor==='retained-heap') {
      const target=config.retainedMiB*1024*1024,initial=v8.getHeapStatistics().used_heap_size;
      while(v8.getHeapStatistics().used_heap_size-initial<target&&retained.length<64)retained.push(Array.from({length:1048576},(_,i)=>i+0.25));
      report.intervention.arrays=retained.length;
    } else if(config.factor==='full-host') {
      if(config.layout!=='workspace')throw new Error('full_host_requires_workspace_layout');
      const {createReadHost}=await import('./read-host.mjs');const {createTrace}=await import('./trace.mjs');
      host=await createReadHost({...config,bindings:true,desktopDiagnostics:false,readOnlyGuard:guard,trace:createTrace({enabled:false})});
      for(let i=0;i<12;i++){await host.query();await wait(20);}
      report.intervention.hostBindings=host.dependencyBindings;
      report.intervention.hostObservations={...host.fixtureObservation,readFailures:host.readFailures(),revision:host.sourceRevision()};
      if(host.readFailures()||!host.fixtureObservation.minSessions)throw new Error('host_stress_read_invalid');
    } else if(config.factor==='diagnostic-hooks') {
      const ipcMain={_invokeHandlers:new Map([['ri00:normalize',normalize]]),eventNames:()=>[],emit:()=>false};
      invoke=()=>ipcMain._invokeHandlers.get('ri00:normalize')();
      observation=installObservation({ipcMain,fs,json:JSON,phase:null,stores:[],timerHosts:[],timers,syncExports:syncBuiltinESMExports,
        AsyncLocalStorage,now:()=>performance.now(),wall:()=>new Date().toISOString()},{durationMs:180000,limit:2000});
    } else if(config.factor==='cpu-profile'||config.factor==='scope-inspection') {
      session=new Session();session.connect();
      if(config.factor==='scope-inspection')report.intervention.inspection=await inspectScopes();
      else {await post('Profiler.enable');await post('Profiler.setSamplingInterval',{interval:1000});await post('Profiler.start');}
    } else throw new Error('unknown_lab_factor');
    report.intervention.wallMs=performance.now()-started;report.intervention.heapAfter=heap();
    await phase('after');
    if(observation){const result=observation.stop();report.restoration.hooks=result.restored.every(Boolean);}
    if(session){
      if(config.factor==='cpu-profile'){const {profile}=await post('Profiler.stop');await post('Profiler.disable');fs.writeFileSync(path.join(config.output,'lab.private.cpuprofile'),JSON.stringify(profile),{mode:0o600});}
      session.disconnect();session=null;
    }
    retained=[];await wait(200);
    await phase('recovery');
    report.ok=true;
  } catch(error){report.ok=false;report.failures.push({name:error.name,code:error.code||null,message:error.message});}
  finally {
    observation?.stop();if(session)session.disconnect();host?.close();
    await wait(20);for(const e of observer.takeRecords())report.gc.push({start:e.startTime,duration:e.duration,kind:e.detail?.kind});observer.disconnect();
    report.guard={...guard.state};guard.close();
    report.inputUnchanged=hash(fs.readFileSync(file))===inputHash;
    if(!report.inputUnchanged||report.guard.sourceWritesDenied)report.ok=false;
    for(const phase of report.phases) {
      for(const read of phase.transitionReads)read.gcMs=intersectMs(read.start,read.end,report.gc);
      for(const batch of phase.batches){batch.control.gcMs=intersectMs(batch.control.start,batch.control.end,report.gc);for(const read of batch.reads)read.gcMs=intersectMs(read.start,read.end,report.gc);}
      const reads=phase.batches.flatMap(x=>x.reads),clean=reads.filter(x=>x.gcMs===0);
      phase.summary={batchWallMs:median(phase.batches.map(x=>x.end-x.start)),batchUserCpuMs:median(phase.batches.map(x=>x.userMs)),
        batchSystemCpuMs:median(phase.batches.map(x=>x.systemMs)),readUserCpuMs:median(reads.map(x=>x.userMs)),
        cleanReadUserCpuMs:median(clean.map(x=>x.userMs)),cleanReads:clean.length,totalReads:reads.length,
        calibrationUserCpuMs:median(phase.batches.map(x=>x.control.userMs))};
      phase.summary.transitionUserCpuMs=phase.transitionReads.reduce((sum,x)=>sum+x.userMs,0);
    }
    report.finishedAt=new Date().toISOString();
  }
  return report;
}
