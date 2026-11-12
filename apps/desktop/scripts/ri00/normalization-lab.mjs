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
  const {readJsonl,normalizeEvidenceIndexRecord,retainInteractiveEvidence,mergeEvidenceIndexRecords}=await import(pathToFileURL(moduleFile).href);
  const records=readJsonl(file),rawDigest=digestRows(records);
  let normalize=()=>retainInteractiveEvidence(records.map(normalizeEvidenceIndexRecord).filter(Boolean));
  let inspectedFunction=normalizeEvidenceIndexRecord;
  if(config.target==='evidence-read'){
    const {createGoalPlanEvidence}=await import(pathToFileURL(path.join(runtimeRoot,'dist/goal-plan-evidence.mjs')).href);
    const evidence=createGoalPlanEvidence({storeDir:path.dirname(file)});inspectedFunction=evidence.readEvidenceIndex;normalize=()=>evidence.readEvidenceIndex();
  }else if(config.target==='store'){
    const {createGoalPlanStore}=await import(pathToFileURL(path.join(runtimeRoot,'dist/goal-plan-store.mjs')).href);
    const store=createGoalPlanStore({storeDir:path.dirname(file)});inspectedFunction=store.listEvidenceIndex;normalize=()=>store.listEvidenceIndex();
  }
  let invoke=normalize,observation,session,host,retained=[],activeRead;
  const post=(method,params={})=>new Promise((resolve,reject)=>session.post(method,params,(error,result)=>error?reject(error):resolve(result)));
  const report={kind:'isolated-normalization-trigger-experiment',layout:config.layout,factor:config.factor,target:config.target,prelude:config.prelude,
    replicate:config.replicate,startedAt:new Date().toISOString(),inputSha256:inputHash,rawDigest,rawRows:records.length,
    moduleSha256:hash(fs.readFileSync(moduleFile)),functionSha256:{normalize:hash(normalizeEvidenceIndexRecord.toString()),retain:hash(retainInteractiveEvidence.toString()),reader:hash(inspectedFunction.toString())},
    runtime:{electron:process.versions.electron,node:process.versions.node,arch:process.arch,cachedDataVersionTag:v8.cachedDataVersionTag(),cpuMetric:'process.threadCpuUsage',calibration:'native-SHA256-16MiB'},
    phases:[],gc:[],failures:[],intervention:{},restoration:{},training:{}};
  const observer=new PerformanceObserver(list=>{
    for(const entry of list.getEntries())report.gc.push({start:entry.startTime,duration:entry.duration,kind:entry.detail?.kind});
  });
  observer.observe({entryTypes:['gc']});
  function heap(){const h=v8.getHeapStatistics();return {used:h.used_heap_size,total:h.total_heap_size,external:h.external_memory,code:v8.getHeapCodeStatistics()};}
  function retainNormalized(){
    if(records.length>100000||fs.statSync(file).size>128*1024*1024)throw new Error('retained_normalization_input_too_large');
    const before=heap(),target=config.retainedMiB*1024*1024;
    while(heap().used-before.used<target&&retained.length<8)retained.push(retainInteractiveEvidence(records.map(normalizeEvidenceIndexRecord).filter(Boolean)));
    return {arrays:retained.length,rows:retained.reduce((sum,rows)=>sum+rows.length,0),heapBefore:before,heapAfter:heap(),requestedRetainedMiB:config.retainedMiB};
  }
  function trainWriterShapes(){
    // recordEvidenceRefs builds this base order and spreads evidenceRef last. Values
    // come only from the frozen records; neither the source cache nor file is edited.
    const order=['createdAt','bodyPreview','interactiveInspection','planId','conversationId','streamId','toolCallId','capabilityId','toolName','artifactRefs','userArtifacts','evidenceRef'];
    const selected=Array.from({length:Math.min(4096,records.length)},(_,i)=>records[Math.floor(i*records.length/Math.min(4096,records.length))]);
    const variants=selected.map(row=>Object.fromEntries(order.filter(key=>Object.hasOwn(row,key)).map(key=>[key,row[key]])));
    if(digestRows(selected.map(normalizeEvidenceIndexRecord))!==digestRows(variants.map(normalizeEvidenceIndexRecord)))throw new Error('writer_variant_semantics_changed');
    for(let round=0;round<20;round++)variants.map(normalizeEvidenceIndexRecord);
    return {records:variants.length,calls:variants.length*22,outputMatched:true};
  }
  function replayEvidenceMerges(){
    const current=new Map();let merges=0,normalized=0;
    for(const raw of records){const incoming=normalizeEvidenceIndexRecord(raw);if(!incoming)continue;normalized++;
      const previous=current.get(incoming.evidenceRef);if(previous)merges++;
      current.set(incoming.evidenceRef,mergeEvidenceIndexRecords(previous,incoming));}
    retained.push([...current.values()]);return {rawRows:records.length,normalized,merges,unique:current.size,syntheticFields:false};
  }
  async function ensureHost(){
    if(host)return host;
    const {createReadHost}=await import('./read-host.mjs');const {createTrace}=await import('./trace.mjs');
    host=await createReadHost({...config,bindings:true,desktopDiagnostics:false,readOnlyGuard:guard,trace:createTrace({enabled:false})});
    return host;
  }
  if(config.target==='host'){
    await ensureHost();
    for(const [object,keys,prefix] of [[host.readPorts.goalPlanStore,['getPlan','listEvidenceIndex'],'GoalPlanStore'],
      [host.readPorts.coordination,['read','readLifecycleFacts','readSnapshot','readSessionControl','readWork'],'Coordination']]){
      for(const key of keys){
        if(typeof object?.[key]!=='function')continue;
        const original=object[key],name=`${prefix}.${key}`;
        object[key]=function(...args){
          if(!activeRead)return Reflect.apply(original,this,args);
          const row=activeRead[name]||=( {calls:0,userMs:0,systemMs:0,wallMs:0,rows:0} );row.calls++;
          if(key==='getPlan')return Reflect.apply(original,this,args);
          const start=performance.now(),cpu=process.threadCpuUsage();
          try{const value=Reflect.apply(original,this,args);if(Array.isArray(value))row.rows+=value.length;return value;}
          finally{const elapsed=cpuElapsed(cpu);row.userMs+=elapsed.userMs;row.systemMs+=elapsed.systemMs;row.wallMs+=performance.now()-start;}
        };
      }
    }
    inspectedFunction=host.readPorts.supervisor.list;normalize=()=>host.sessionFacts();invoke=normalize;
    report.functionSha256.reader=hash(inspectedFunction.toString());
    report.targetContract='Synchronous production SessionSupervisor.list; listObligationGrants adds its separate grant read. Nested component CPU is inclusive, never summed.';
  }
  const trainingStart=performance.now();
  if(config.prelude==='desktop-preview'){
    const {createGoalPlanEvidence}=await import(pathToFileURL(path.join(runtimeRoot,'dist/goal-plan-evidence.mjs')).href);
    const evidence=createGoalPlanEvidence({storeDir:path.dirname(file)});
    report.training.previewFound=evidence.hasDesktopPreviewEvidence('ri00-nonexistent-plan');
  }else if(config.prelude==='full-host'){
    await ensureHost();for(let i=0;i<12;i++){await host.query();await wait(20);}
  }else if(config.prelude==='retain-normalized'){
    report.training.retention=retainNormalized();
  }else if(config.prelude==='writer-shapes'){
    report.training.writer=trainWriterShapes();
  }else if(config.prelude==='evidence-merge-replay'){
    report.training.mergeReplay=replayEvidenceMerges();
  }
  report.training.wallMs=performance.now()-trainingStart;
  const expected=digestRows(normalize());
  function sampleRead(){
    const components={};activeRead=components;
    const start=performance.now(),thread=process.threadCpuUsage();
    try{const output=invoke();return {start,end:performance.now(),...cpuElapsed(thread),rows:output.length,components};}
    finally{activeRead=undefined;}
  }
  async function phase(name) {
    const result={name,startedAt:new Date().toISOString(),heapBefore:heap(),transitionReads:[],batches:[],calibrationOrder:config.calibrationAfter?'after-timed-reads':'before-timed-reads'};
    for(let i=0;i<12;i++)result.transitionReads.push(sampleRead());
    for(let i=0;i<config.warmReads;i++)invoke();
    for(let i=0;i<3;i++)calibration();
    for(let batch=0;batch<config.batches;batch++) {
      if(config.factor==='idle-cadence'&&name==='after')await wait(config.idleMs);
      const control=()=>{const before=process.threadCpuUsage(),start=performance.now(),value=calibration();return {start,end:performance.now(),...cpuElapsed(before),value};};
      const beforeControl=config.calibrationAfter?null:control();
      const row={batch,reads:[],start:performance.now()},cpu=process.threadCpuUsage();
      for(let read=0;read<config.readsPerBatch;read++) {
        row.reads.push(sampleRead());
      }
      row.end=performance.now();Object.assign(row,cpuElapsed(cpu));row.control=beforeControl||control();result.batches.push(row);
      await wait(20);
    }
    result.heapAfter=heap();result.outputDigest=digestRows(normalize());
    result.semanticMatch=result.outputDigest===expected;result.rawUnchanged=digestRows(records)===rawDigest;
    if(!result.semanticMatch||!result.rawUnchanged)throw new Error('normalization_input_or_output_changed');
    report.phases.push(result);
  }
  async function inspectScopes() {
    globalThis.__ri00NormalizationFunction=inspectedFunction;
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
    else if(config.factor==='idle-cadence')report.intervention.idleBeforeEachAfterBatchMs=config.idleMs;
    else if(config.factor==='writer-shapes')report.intervention.writer=trainWriterShapes();
    else if(config.factor==='evidence-merge-replay')report.intervention.mergeReplay=replayEvidenceMerges();
    else if(config.factor==='mutate-normalized'){
      const outputs=records.slice(0,2048).map(normalizeEvidenceIndexRecord).filter(Boolean);
      for(const record of outputs)for(const key of Object.keys(record)){
        const value=record[key];record[key]=typeof value==='string'?value+'-ri00-probe':null;record[key]=value;
      }
      report.intervention.mutatedThrowawayOutputs=outputs.length;
    }
    else if(config.factor==='string-coercion'){
      const {normalizeOptionalString}=await import(pathToFileURL(path.join(runtimeRoot,'dist/goal-plan-domain.mjs')).href);
      const values=[0,1.25,true,42n,new String('ri00'),{toString(){return 'ri00';}},['ri00']];
      for(let i=0;i<20000;i++)for(const value of values)normalizeOptionalString(value);
      report.intervention.helperCalls=20000*values.length;
    }
    else if(config.factor==='array-species'){
      const descriptor=Object.getOwnPropertyDescriptor(Array,Symbol.species);
      try{Object.defineProperty(Array,Symbol.species,{...descriptor,get(){return Array;}});[1,2].map(x=>x);}
      finally{Object.defineProperty(Array,Symbol.species,descriptor);}
      report.intervention.descriptorRestored=Object.getOwnPropertyDescriptor(Array,Symbol.species).get===descriptor.get;
    }else if(config.factor==='regexp-exec'){
      const descriptor=Object.getOwnPropertyDescriptor(RegExp.prototype,'exec');
      try{Object.defineProperty(RegExp.prototype,'exec',{...descriptor,value:function(...args){return Reflect.apply(descriptor.value,this,args);}});/^a/.exec('a');}
      finally{Object.defineProperty(RegExp.prototype,'exec',descriptor);}
      report.intervention.descriptorRestored=RegExp.prototype.exec===descriptor.value;
    }else if(config.factor==='array-prototype-element'){
      const descriptor=Object.getOwnPropertyDescriptor(Array.prototype,'0'),length=Object.getOwnPropertyDescriptor(Array.prototype,'length');
      try{Object.defineProperty(Array.prototype,'0',{value:1,configurable:true,writable:true});[].map(x=>x);}
      finally{if(descriptor)Object.defineProperty(Array.prototype,'0',descriptor);else delete Array.prototype[0];Object.defineProperty(Array.prototype,'length',length);}
      report.intervention.descriptorRestored=Object.getOwnPropertyDescriptor(Array.prototype,'0')?.value===descriptor?.value&&Array.prototype.length===length.value;
    }
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
    } else if(config.factor==='retain-normalized'){
      report.intervention.retention=retainNormalized();
    } else if(config.factor==='retained-heap') {
      const target=config.retainedMiB*1024*1024,initial=v8.getHeapStatistics().used_heap_size;
      while(v8.getHeapStatistics().used_heap_size-initial<target&&retained.length<64)retained.push(Array.from({length:1048576},(_,i)=>i+0.25));
      report.intervention.arrays=retained.length;
    } else if(config.factor==='full-host') {
      if(config.layout!=='workspace')throw new Error('full_host_requires_workspace_layout');
      await ensureHost();
      for(let i=0;i<12;i++){await host.query();await wait(20);}
      report.intervention.hostBindings=host.dependencyBindings;
      report.intervention.hostObservations={...host.fixtureObservation,readFailures:host.readFailures(),revision:host.sourceRevision()};
      if(host.readFailures()||!host.fixtureObservation.minSessions)throw new Error('host_stress_read_invalid');
    } else if(config.factor==='diagnostic-hooks'||config.factor==='host-observation') {
      const ipcMain={_invokeHandlers:new Map([['ri00:normalize',normalize]]),eventNames:()=>[],emit:()=>false};
      invoke=()=>ipcMain._invokeHandlers.get('ri00:normalize')();
      const actual=config.factor==='host-observation';
      const phase=actual?await import(pathToFileURL(path.join(runtimeRoot,'dist/diagnostic-phase.mjs')).href):null;
      observation=installObservation({ipcMain,fs,json:JSON,phase,stores:actual?[host.readPorts.coordination]:[],timerHosts:[],timers,syncExports:syncBuiltinESMExports,
        AsyncLocalStorage,now:()=>performance.now(),wall:()=>new Date().toISOString()},{durationMs:180000,limit:2000,deepBuiltins:!actual});
      if(actual){observation.instrumentObject(host.readPorts.goalPlanStore,'GoalPlanStore',['getPlan','listEvidenceIndex']);
        observation.instrumentObject(host.readPorts.supervisor,'SessionSupervisor',['list'],{rootWhenUnattributed:true});}
    } else if(config.factor==='cpu-profile'||config.factor==='scope-inspection') {
      session=new Session();session.connect();
      if(config.factor==='scope-inspection')report.intervention.inspection=await inspectScopes();
      else {await post('Profiler.enable');await post('Profiler.setSamplingInterval',{interval:1000});await post('Profiler.start');}
    } else throw new Error('unknown_lab_factor');
    report.intervention.wallMs=performance.now()-started;report.intervention.heapAfter=heap();
    await phase('after');
    if(observation){const result=observation.stop();report.restoration.hooks=result.restored.every(Boolean);
      report.intervention.observation={records:result.records.length,dropped:result.dropped,addedInvokeChannels:result.addedInvokeChannels};}
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
    report.host=host?{bindings:host.dependencyBindings,observations:host.fixtureObservation,readFailures:host.readFailures()}:null;
    if(report.host&&(report.host.readFailures||!report.host.observations.minSessions))report.ok=false;
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
      phase.summary.components=Object.fromEntries([...new Set(reads.flatMap(read=>Object.keys(read.components)))].map(name=>[name,
        Object.fromEntries(['calls','userMs','systemMs','wallMs','rows'].map(key=>[key,median(reads.map(read=>read.components[name]?.[key]||0))]))]));
    }
    report.finishedAt=new Date().toISOString();
  }
  return report;
}
