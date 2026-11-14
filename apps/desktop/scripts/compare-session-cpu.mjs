import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawn,execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { controlledSessionRead } from './ri00/paired-read-cpu.mjs';
import { controlledCacheRead } from './ri00/cache-read-cpu.mjs';
import { createIndexCounterProbe } from './ri00/index-counter-probe.mjs';
import { browserMainCounterDelta } from './ri00/thread-counter-delta.mjs';
import { profileClock } from './ri00/profile-clock.mjs';
import { readV8FunctionState } from './ri00/v8-read-state.mjs';
import { captureFixtureLayout,summarizeFixtureLayout } from './ri00/heap-layout.mjs';
import { readPortReferences } from './ri00/inspector-read-ports.mjs';
import { inspectClosure } from './ri00/trace.mjs';
import { resolveDestination,productionIdentity,fixtureIdentity,contentIdentity } from './ri00/identity.mjs';

const args=process.argv.slice(2),option=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
const isolationOnly=args.includes('--isolation-only'),pid=Number(option('--pid','0')),port=Number(option('--port','9229'));
const mode=option('--mode','session');if(!['session','cache','counters','ownership','vm-state'].includes(mode))throw new Error('invalid_comparison_mode');
const mainOnly=args.includes('--main-only');
if(mainOnly&&(isolationOnly||mode!=='counters'))throw new Error('main_only_requires_counter_mode');
const mainPhases=args.includes('--main-probe-phases');
if(mainPhases&&!mainOnly)throw new Error('main_probe_phases_require_main_only');
const profileCounters=args.includes('--profile-counters');
if(profileCounters&&mode!=='counters')throw new Error('counter_profile_requires_counter_mode');
const profileSession=args.includes('--profile-session');
if(profileSession&&mode!=='session')throw new Error('profile_requires_session_mode');
if(isolationOnly&&!['counters','ownership','vm-state'].includes(mode))throw new Error('invalid_isolation_mode');
const counterTarget=option('--counter-target','index'),counterRounds=Number(option('--counter-rounds','3')),counterIdleMs=Number(option('--counter-idle-ms','14500'));
const retainedCopies=option('--retain-index-copies')===undefined?null:Number(option('--retain-index-copies'));
const startupOrder=option('--startup-order','none'),hotOnly=args.includes('--hot-only');
const vmAfter=args.includes('--vm-after');
if(vmAfter&&(!isolationOnly||mode!=='counters'))throw new Error('vm_after_requires_isolated_counters');
if(args.includes('--vm-debug-print')&&!vmAfter)throw new Error('private_layout_requires_owned_vm_after');
if(args.includes('--heap-layout')&&!vmAfter)throw new Error('heap_layout_requires_owned_vm_after');
// Startup controls always affect the owned child. Main receives no prelude.
const isolatedSessionCounters=isolationOnly&&mode==='counters'&&counterTarget==='session';
if(!['none','index-first','session-first'].includes(startupOrder)||(startupOrder!=='none'&&!isolatedSessionCounters&&mode!=='session')||(hotOnly&&!isolatedSessionCounters))throw new Error('startup_control_requires_owned_session_child');
if(startupOrder!=='none'&&retainedCopies!==null)throw new Error('startup_and_retention_controls_are_separate');
const sessionRounds=Number(option('--session-rounds','3')),sessionDelayMs=Number(option('--session-delay-ms','250'));
if(!Number.isInteger(sessionRounds)||sessionRounds<3||sessionRounds>9||!Number.isInteger(sessionDelayMs)||sessionDelayMs<100||sessionDelayMs>1000)throw new Error('unbounded_session_configuration');
if(retainedCopies!==null&&(!isolationOnly||mode!=='counters'||!Number.isInteger(retainedCopies)||retainedCopies<0||retainedCopies>8))throw new Error('bounded_retention_requires_isolated_counter_mode');
const engineExperiment=option('--engine-experiment','default');
const engineFlags={default:'','trace-gc':'--trace-gc-nvp --trace-memory-reducer --trace-concurrent-marking',
  'trace-no-memory-reducer':'--no-memory-reducer --trace-gc-nvp --trace-memory-reducer --trace-concurrent-marking',
  'no-memory-reducer':'--no-memory-reducer','fixed-nursery':'--min-semi-space-size=16 --max-semi-space-size=16',
  'fixed-growth':'--heap-growing-percent=500',
  'no-reducer-fixed-growth':'--no-memory-reducer --heap-growing-percent=500',
  'trace-fixed-growth':'--no-memory-reducer --heap-growing-percent=500 --trace-gc-nvp --trace-incremental-marking --trace-concurrent-marking',
  'trace-tiering':'--trace-opt --trace-deopt --trace-pretenuring --trace-pretenuring-statistics'};
if(!Object.hasOwn(engineFlags,engineExperiment)||engineExperiment!=='default'&&!isolationOnly)throw new Error('engine_controls_require_isolation');
if(!['index','session'].includes(counterTarget)||!Number.isInteger(counterRounds)||counterRounds<3||counterRounds>9||!Number.isInteger(counterIdleMs)||counterIdleMs<20||counterIdleMs>15000)throw new Error('unbounded_counter_configuration');
let mainPayload;
if(mainOnly&&counterTarget==='session'){
  const file=option('--payload-file');if(!file||fs.statSync(file).size>4096)throw new Error('bounded_session_payload_required');
  mainPayload=JSON.parse(fs.readFileSync(file,'utf8'));
  if(typeof mainPayload?.workspaceId!=='string'||!mainPayload.workspaceId||mainPayload.workspaceId.length>512||Object.keys(mainPayload).some(key=>key!=='workspaceId'))throw new Error('invalid_session_payload');
}
if(args.includes('--clone-normalizers')&&mode!=='cache')throw new Error('clones_require_cache_comparison');
if((!isolationOnly&&(!Number.isInteger(pid)||pid<1))||!Number.isInteger(port)||port<1024||port>65535)throw new Error('invalid_target');
for(const name of ['--module-root','--fixture-root','--output','--parent-hash'])if(!option(name))throw new Error('explicit_source_configuration_required');
if(Boolean(option('--coordination-root'))===Boolean(option('--coordination-snapshot')))throw new Error('one_coordination_source_required');
const moduleRoot=fs.realpathSync(option('--module-root')),fixtureRoot=fs.realpathSync(option('--fixture-root')),
  coordinationLiveRoot=option('--coordination-root')?fs.realpathSync(option('--coordination-root')):null,
  coordinationSnapshot=option('--coordination-snapshot')?fs.realpathSync(option('--coordination-snapshot')):null,output=resolveDestination(option('--output'));
const personal=resolveDestination(path.join(os.homedir(),'.peer-agent'));
if([fixtureRoot,output].some(root=>root===personal||root.startsWith(personal+path.sep))||output===fixtureRoot||output.startsWith(fixtureRoot+path.sep)
  ||fs.existsSync(output)&&fs.readdirSync(output).length)throw new Error('isolated_fixture_and_new_output_required');
fs.mkdirSync(output,{recursive:true,mode:0o700});fs.chmodSync(output,0o700);
const harness=()=>['compare-session-cpu.mjs','ri00/paired-read-cpu.mjs','ri00/cache-read-cpu.mjs','ri00/index-counter-probe.mjs','ri00/thread-counter-delta.mjs','ri00/profile-clock.mjs','ri00/v8-read-state.mjs','ri00/heap-layout.mjs','ri00/darwin-process-counters.py','ri00/read-host.mjs','ri00/inspector-read-ports.mjs','ri00/readonly-coordination.mjs','ri00/identity.mjs','ri00/trace.mjs'].map(relative=>({relative,
  sha256:createHash('sha256').update(fs.readFileSync(new URL(relative,import.meta.url))).digest('hex')}));
const report={kind:mainOnly?'controlled-existing-main-cpu-counters-not-a-fix':isolationOnly?'isolated-hot-idle-hot-cpu-counters-not-a-fix':'controlled-main-child-main-session-cpu-not-a-fix',mode,isolationOnly,counterTarget,startedAt:new Date().toISOString(),harness:harness(),production:productionIdentity(moduleRoot),
  sourceHead:execFileSync('git',['rev-parse','HEAD'],{cwd:moduleRoot,encoding:'utf8'}).trim(),failures:[]};
report.engineExperiment={kind:engineExperiment,flags:engineFlags[engineExperiment],productSettingChanged:false};
report.retainedCopies=retainedCopies;
report.startupOrder=startupOrder;report.hotOnly=hotOnly;
if(mode==='session')report.sessionProbe={rounds:sessionRounds,delayMs:sessionDelayMs,calibrationOrder:'after-timed-read',contentHashInController:true};
if(isolationOnly){report.fixtureIdentity=fixtureIdentity(fixtureRoot);report.snapshotIdentity=coordinationSnapshot?contentIdentity(coordinationSnapshot):null;}
const require=createRequire(path.join(moduleRoot,'apps/desktop/package.json')),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let child,main,fixture,verified=false,counterProcess,counterReady,childStdout='',childStderr='',traceDropped=0;
const counterPending=new Map();let counterSequence=0;
function counterRead(pid){return new Promise((resolve,reject)=>{const id=++counterSequence,timer=setTimeout(()=>{counterPending.delete(id);reject(new Error('counter_sidecar_timeout'));},3000);
  counterPending.set(id,{resolve,reject,timer});counterProcess.stdin.write(JSON.stringify({id,pid})+'\n');});}
async function startCounters(){
  counterProcess=spawn('python3',[new URL('./ri00/darwin-process-counters.py',import.meta.url).pathname],{stdio:['pipe','pipe','pipe']});
  let errorLog='';counterProcess.stderr.on('data',bytes=>{errorLog+=bytes;});
  const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('counter_sidecar_not_ready')),3000);
    createInterface({input:counterProcess.stdout}).on('line',line=>{const value=JSON.parse(line);if(value.ready){clearTimeout(timer);counterReady=value;resolve(value);return;}
      const pending=counterPending.get(value.id);if(!pending)return;counterPending.delete(value.id);clearTimeout(pending.timer);
      value.ok?pending.resolve(value.point):pending.reject(new Error(`counter_read_failed:${value.errno}`));});
    counterProcess.once('error',reject);counterProcess.once('exit',()=>{clearTimeout(timer);reject(new Error('counter_sidecar_exited'));});});
  await ready;report.counterRuntime=counterReady;counterProcess.once('close',()=>fs.writeFileSync(path.join(output,'counter-stderr.private.txt'),errorLog,{mode:0o600}));
}
async function connect(url){
  const socket=new WebSocket(url);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  let sequence=0;const pending=new Map();
  socket.onmessage=event=>{const reply=JSON.parse(event.data),request=pending.get(reply.id);if(!request)return;pending.delete(reply.id);clearTimeout(request.timer);
    reply.error?request.reject(new Error(reply.error.message)):request.resolve(reply.result);};
  socket.onclose=()=>{for(const request of pending.values()){clearTimeout(request.timer);request.reject(new Error('inspector_disconnected'));}pending.clear();};
  return {socket,post(method,params={}){return new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('inspector_timeout'));},30000);
    pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});}};
}
async function evaluate(session,expression,returnByValue=true,awaitPromise=false){const reply=await session.post('Runtime.evaluate',{expression,returnByValue,awaitPromise});
  if(reply.exceptionDetails)throw new Error('evaluation_failed');return reply.result;}
async function read(session,supervisor,store,payload){
  const directory=await session.post('Runtime.callFunctionOn',{objectId:store,functionDeclaration:'function(){return this.getStoreDir();}',returnByValue:true});
  if(directory.exceptionDetails)throw new Error('session_store_directory_unavailable');const file=path.join(directory.result.value,'evidence-index.jsonl');
  const identity=()=>{const s=fs.statSync(file,{bigint:true});return {sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex'),stampSha256:createHash('sha256').update(JSON.stringify(
    ['dev','ino','size','mtimeNs','ctimeNs'].map(key=>String(s[key])))).digest('hex')};};const before=identity();
  const reply=await session.post('Runtime.callFunctionOn',{objectId:supervisor,functionDeclaration:controlledSessionRead.toString(),
    arguments:[{objectId:store},{value:payload},{value:{rounds:sessionRounds,delayMs:sessionDelayMs,jsControl:args.includes('--js-control')}}],awaitPromise:true,returnByValue:true});
  if(reply.exceptionDetails)throw new Error('paired_read_failed');const result=reply.result.value,after=identity();
  result.sourceContentObservedBy='controller; target observes metadata only, avoiding a full-index hash buffer in its heap';
  result.sourceBefore.sha256=before.sha256;result.sourceAfter.sha256=after.sha256;
  result.ok=result.ok&&before.sha256===after.sha256&&before.stampSha256===result.sourceBefore.stampSha256&&after.stampSha256===result.sourceAfter.stampSha256;
  return result;
}
async function profiledRead(session,supervisor,store,payload,label){
  if(!profileSession)return read(session,supervisor,store,payload);
  let running=false,result,profile;
  const marker=async()=>{const reply=await evaluate(session,'(function ri00PairedClockMarker(){const clock=()=>Number(process.hrtime.bigint())/1e6;const start=clock();let value=0;while(clock()-start<25)value+=Math.sqrt(value+1);return {start,end:clock()};})()');return reply.value;};
  await session.post('Profiler.enable');
  try{
    await session.post('Profiler.setSamplingInterval',{interval:500});await session.post('Profiler.start');running=true;
    const before=await marker();result=await read(session,supervisor,store,payload);const after=await marker();
    ({profile}=await session.post('Profiler.stop'));running=false;
    fs.writeFileSync(path.join(output,`${label}.cpuprofile.private.json`),JSON.stringify(profile),{mode:0o600});
    result.profile={kind:'instrumented-500us-not-unprofiled-acceptance',before,after,samples:profile.samples?.length||0};
    return result;
  }finally{if(running)await session.post('Profiler.stop').catch(()=>{});await session.post('Profiler.disable');}
}
async function cacheRead(session,store){
  const props=async objectId=>session.post('Runtime.getProperties',{objectId,ownProperties:true});
  const property=async(objectId,key)=>(await props(objectId)).result.find(row=>row.name===key)?.value.objectId;
  async function binding(objectId,key){
    const scopes=(await props(objectId)).internalProperties?.find(row=>row.name==='[[Scopes]]')?.value.objectId;
    if(!scopes)return;
    for(const row of (await props(scopes)).result){if(!/^\d+$/.test(row.name)||!row.value?.objectId)continue;
      const found=(await props(row.value.objectId)).result.find(value=>value.name===key);if(found)return found.value?.objectId;}
  }
  const warm=await session.post('Runtime.callFunctionOn',{objectId:store,functionDeclaration:'function(){return this.listEvidenceIndex().length;}',returnByValue:true});
  if(warm.exceptionDetails||!warm.result.value)throw new Error('cache_priming_failed');
  let reader=await property(store,'listEvidenceIndex'),cache;
  for(let i=0;i<8;i++){cache=await binding(reader,'evidenceIndexReadCache');if(cache)break;reader=await binding(reader,'original');if(!reader)break;}
  if(!reader||!cache)throw new Error('production_evidence_cache_unavailable');
  const refs=[];for(const name of ['normalizeEvidenceIndexRecord','retainInteractiveEvidence','readJsonl']){
    const id=await binding(reader,name);if(!id)throw new Error('production_normalizer_binding_unavailable');refs.push({objectId:id});}
  const directory=await session.post('Runtime.callFunctionOn',{objectId:store,functionDeclaration:'function(){return this.getStoreDir();}',returnByValue:true});
  if(directory.exceptionDetails)throw new Error('store_directory_unavailable');
  let dependencies;
  if(args.includes('--clone-normalizers')){
    const names=['normalizeOptionalString','normalizeInteractiveInspectionReceipt','interactiveInspectionEvidenceRef','normalizeEvidenceRefList','normalizeInteractiveUserArtifact'];
    const argumentsForFunctions=[];
    for(const name of names){const id=await binding(refs[0].objectId,name);if(!id)throw new Error('clone_dependency_unavailable');argumentsForFunctions.push({objectId:id});}
    const stringArray=await binding(argumentsForFunctions[3].objectId,'normalizeStringArray');if(!stringArray)throw new Error('string_array_dependency_unavailable');
    argumentsForFunctions.push({objectId:stringArray});
    const reply=await session.post('Runtime.callFunctionOn',{objectId:reader,functionDeclaration:'function(...functions){return functions;}',arguments:argumentsForFunctions});
    if(reply.exceptionDetails||!reply.result.objectId)throw new Error('clone_dependency_pack_failed');dependencies={objectId:reply.result.objectId};
  }
  const reply=await session.post('Runtime.callFunctionOn',{objectId:cache,functionDeclaration:controlledCacheRead.toString(),
    arguments:[...refs,{objectId:reader},{value:directory.result.value},...(dependencies?[dependencies]:[])],awaitPromise:true,returnByValue:true});
  if(reply.exceptionDetails)throw new Error('cache_comparison_failed');return reply.result.value;
}
async function ownershipRead(session,store){
  const props=async objectId=>session.post('Runtime.getProperties',{objectId,ownProperties:true});
  async function binding(objectId,key){
    const scopes=(await props(objectId)).internalProperties?.find(row=>row.name==='[[Scopes]]')?.value.objectId;if(!scopes)return;
    for(const row of (await props(scopes)).result){if(!/^\d+$/.test(row.name)||!row.value?.objectId)continue;
      const found=(await props(row.value.objectId)).result.find(value=>value.name===key);if(found)return found.value?.objectId;}
  }
  const result={kind:'named-read-cache-ownership-metadata-only',caches:{}};
  result.heap=(await evaluate(session,'({heap:process.getBuiltinModule("v8").getHeapStatistics(),spaces:process.getBuiltinModule("v8").getHeapSpaceStatistics()})')).value;
  const directory=await session.post('Runtime.callFunctionOn',{objectId:store,functionDeclaration:'function(){return this.getStoreDir();}',returnByValue:true});
  if(directory.exceptionDetails)throw new Error('ownership_store_directory_unavailable');
  const file=path.join(directory.result.value,'evidence-index.jsonl');
  const identity=()=>{const s=fs.statSync(file,{bigint:true});return {sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex'),stampSha256:createHash('sha256').update(JSON.stringify(
    ['dev','ino','size','mtimeNs','ctimeNs'].map(key=>String(s[key])))).digest('hex'),bytes:String(s.size)};};
  result.sourceBefore=identity();let method=(await props(store)).result.find(row=>row.name==='getPlan')?.value.objectId,readJson;
  for(let i=0;i<8&&method;i++){readJson=await binding(method,'readJson');if(readJson)break;method=await binding(method,'original');}
  if(!readJson)throw new Error('read_json_owner_unavailable');
  for(const name of ['jsonReadCache','jsonlReadCache']){
    const id=await binding(readJson,name);if(!id){result.caches[name]={state:'binding-unavailable'};continue;}
    const reply=await session.post('Runtime.callFunctionOn',{objectId:id,functionDeclaration:`function(){
      const counts={};let bytes=0,entries=0,rows=0;
      for(const [key,value]of this){const category=typeof key==='string'&&key.includes('/goal-plans/')?'goal-plans':'other';
        const item=counts[category]||=( {entries:0,sourceFileBytes:0} );item.entries++;entries++;
        if(Number.isFinite(value?.size)){item.sourceFileBytes+=value.size;bytes+=value.size;}if(Array.isArray(value?.records))rows+=value.records.length;}
      return {state:'map',entries,sourceFileBytes:bytes,cachedJsonlRows:rows,categories:counts,limit:'source byte totals are not retained heap size'};
    }`,returnByValue:true});
    if(reply.exceptionDetails)throw new Error('read_cache_metadata_failed');result.caches[name]=reply.result.value;
  }
  result.sourceAfter=identity();result.sourceUnchanged=JSON.stringify(result.sourceBefore)===JSON.stringify(result.sourceAfter);result.ok=result.sourceUnchanged;return result;
}
async function vmStateRead(session,store,debugLayout=false){
  const props=async id=>session.post('Runtime.getProperties',{objectId:id,ownProperties:true});
  const property=async(id,key)=>(await props(id)).result.find(row=>row.name===key)?.value.objectId;
  async function binding(id,key){const scopes=(await props(id)).internalProperties?.find(row=>row.name==='[[Scopes]]')?.value.objectId;if(!scopes)return;
    for(const row of (await props(scopes)).result){if(!/^\d+$/.test(row.name)||!row.value?.objectId)continue;const found=(await props(row.value.objectId)).result.find(value=>value.name===key);if(found)return found.value?.objectId;}}
  let reader=await property(store,'listEvidenceIndex');
  for(let i=0;i<8;i++){if(await binding(reader,'evidenceIndexReadCache'))break;const original=await binding(reader,'original');if(!original)break;reader=original;}
  const normalizer=await binding(reader,'normalizeEvidenceIndexRecord'),retain=await binding(reader,'retainInteractiveEvidence');
  if(!normalizer||!retain)throw new Error('vm_production_normalizer_unavailable');
  const refs=[normalizer,retain];
  for(const name of ['normalizeOptionalString','normalizeEvidenceRefList']){const id=await binding(normalizer,name);if(!id)throw new Error('vm_helper_unavailable');refs.push(id);}
  const stringArray=await binding(refs[3],'normalizeStringArray');if(!stringArray)throw new Error('vm_string_array_unavailable');refs.push(stringArray);
  let getPlan=await property(store,'getPlan');for(let i=0;i<8;i++){if(await binding(getPlan,'readJson'))break;const original=await binding(getPlan,'original');if(!original)break;getPlan=original;}refs.push(getPlan);
  const pathObject=await evaluate(session,'process.getBuiltinModule("path")',false);refs.push(await property(pathObject.objectId,'join'),await property(pathObject.objectId,'normalize'));
  if(refs.some(id=>!id))throw new Error('vm_named_function_unavailable');
  const readCache=await binding(reader,'evidenceIndexReadCache');
  const reply=await session.post('Runtime.callFunctionOn',{objectId:reader,functionDeclaration:readV8FunctionState.toString(),arguments:[...refs.map(objectId=>({objectId})),readCache?{objectId:readCache}:{value:null},{value:debugLayout}],returnByValue:true});
  if(reply.exceptionDetails)throw new Error('vm_metadata_failed');const result=reply.result.value;
  // Keep the same content identity contract as the other context modes, without
  // introducing a content-hash buffer into the inspected process.
  const identity=await ownershipRead(session,store);result.sourceBefore=identity.sourceBefore;result.sourceAfter=identity.sourceAfter;result.sourceUnchanged=identity.sourceUnchanged;
  if(args.includes('--heap-layout')){
    const file=path.join(output,'layout.private.heapsnapshot');
    const capture=await session.post('Runtime.callFunctionOn',{objectId:readCache,functionDeclaration:captureFixtureLayout.toString(),arguments:[{objectId:normalizer},{value:file}],returnByValue:true});
    if(capture.exceptionDetails)throw new Error('owned_heap_layout_capture_failed');
    result.heapCapture=capture.result.value;
    if(fs.statSync(file).size>512*1024*1024)throw new Error('heap_layout_analysis_size_limit');
    result.heapLayout=summarizeFixtureLayout(JSON.parse(fs.readFileSync(file,'utf8')));
  }
  result.ok=result.ok&&identity.ok;return result;
}
async function counterModeRead(session,store,pid,options={}){
  if(profileCounters&&!options.profileActive){
    let running=false;const markers=[];
    const marker=async name=>(await evaluate(session,`(function ${name}(){const clock=()=>Number(process.hrtime.bigint())/1e6;const start=clock();let value=0;while(clock()-start<25)value+=Math.sqrt(value+1);return {name:${JSON.stringify(name)},start,end:clock()};})()`)).value;
    await session.post('Profiler.enable');
    try{
      await session.post('Profiler.setSamplingInterval',{interval:500});await session.post('Profiler.start');running=true;
      markers.push(await marker('ri00CounterStart'));
      const calibration=(await evaluate(session,'({hrtimeMs:Number(process.hrtime.bigint())/1e6,performanceMs:process.getBuiltinModule("perf_hooks").performance.now()})')).value;
      const result=await counterModeRead(session,store,pid,{...options,profileActive:true});
      markers.push(await marker('ri00CounterStop'));
      const {profile}=await session.post('Profiler.stop');running=false;
      const label=options.label||'counter';
      fs.writeFileSync(path.join(output,`${label}.cpuprofile.private.json`),JSON.stringify(profile),{mode:0o600});
      result.profile={kind:'instrumented-500us-not-unprofiled-acceptance',clock:profileClock(profile,markers),calibration,samples:profile.samples?.length||0};
      return result;
    }finally{if(running)await session.post('Profiler.stop').catch(()=>{});await session.post('Profiler.disable');}
  }
  const phased=isolationOnly||options.phased===true;
  const directory=await session.post('Runtime.callFunctionOn',{objectId:store,functionDeclaration:'function(){return this.getStoreDir();}',returnByValue:true});
  if(directory.exceptionDetails)throw new Error('counter_store_directory_unavailable');
  const file=path.join(directory.result.value,'evidence-index.jsonl');
  const identity=()=>{const s=fs.statSync(file,{bigint:true});return {sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex'),stampSha256:createHash('sha256').update(JSON.stringify(
    ['dev','ino','size','mtimeNs','ctimeNs'].map(key=>String(s[key])))).digest('hex'),bytes:String(s.size)};};
  const target=counterTarget;
  const result={kind:'native-process-counters-around-controlled-read',target,delayMs:options.delayMs??100,sourceBefore:identity(),points:[],failures:[]};
  result.clockCalibration=(await evaluate(session,'({hrtimeMs:Number(process.hrtime.bigint())/1e6,performanceMs:process.getBuiltinModule("perf_hooks").performance.now()})')).value;
  const created=await session.post('Runtime.callFunctionOn',{objectId:store,functionDeclaration:createIndexCounterProbe.toString(),
    arguments:[target==='session'?{objectId:options.supervisor}:{value:null},{value:options.payload??null},
      {value:{observeBackground:mainPhases,closeInspectorOnWatchdog:verified&&args.includes('--close-inspector')}}]});
  if(created.exceptionDetails||!created.result.objectId)throw new Error('counter_probe_creation_failed');const probe=created.result.objectId;
  const invoke=async kind=>{const reply=await session.post('Runtime.callFunctionOn',{objectId:probe,functionDeclaration:'function(kind){return this.read(kind);}',arguments:[{value:kind}],returnByValue:true});
    if(reply.exceptionDetails)throw new Error('counter_probe_read_failed');return reply.result.value;};
  try{
    result.prime=await invoke(target);await wait(100);
    if(phased){result.warmReads=[];for(let i=0;i<6;i++){result.warmReads.push(await invoke(target));await wait(20);}}
    for(let round=0;round<counterRounds;round++){
      if(phased)await wait(result.delayMs);
      for(const kind of (phased?[target,'native','noop']:['noop',target,'native',target,'native',target])){
      const before=await counterRead(pid),start=performance.now(),row=await invoke(kind),end=performance.now(),after=await counterRead(pid);
      result.points.push({round,row,before,after,transportWallMs:end-start});if(!phased)await wait(100);
      }
      if(phased&&result.delayMs>1000){const row=result.points.findLast(point=>point.round===round&&point.row.kind===target)?.row;
        console.log(JSON.stringify({counterRound:round,delayMs:result.delayMs,target,wallMs:row.end-row.start,userMs:row.threadUserMs,evidenceUserMs:row.evidence.reduce((sum,span)=>sum+span.userMs,0)}));}
    }
    result.ok=true;
  }catch(error){result.ok=false;result.failures.push(error.message);}
  finally{
    // GC PerformanceEntries are queued on Node's loop, while CDP calls can run
    // through Chromium without draining that queue. A controller sleep is not
    // an acknowledgement that the final entries have reached the observer.
    const stopped=await session.post('Runtime.callFunctionOn',{objectId:probe,
      functionDeclaration:'async function(){await new Promise(resolve=>setImmediate(()=>setImmediate(resolve)));return this.stop();}',awaitPromise:true,returnByValue:true});
    if(stopped.exceptionDetails)throw new Error('counter_probe_cleanup_failed');result.observation=stopped.result.value;
    result.gcDeliveryDrain='two-owned-node-check-turns-before-stop; not proof of all VM GC events';
    for(let i=0;i<result.points.length;i++){result.points[i].row=result.observation.reads[i+1+(result.warmReads?.length||0)];
      const p=result.points[i],delta={};for(const key of ['ri_user_time','ri_system_time','ri_instructions','ri_cycles',...Object.keys(p.before.values).filter(key=>key.startsWith('ri_cpu_time_qos_'))]){
        delta[key]=String(BigInt(p.after.values[key])-BigInt(p.before.values[key]));}
      p.delta=delta;p.processIdentityStable=p.before.values.ri_proc_start_abstime===p.after.values.ri_proc_start_abstime;
      p.nativeCpuMs=(Number(delta.ri_user_time)+Number(delta.ri_system_time))*counterReady.timebase.numer/counterReady.timebase.denom/1e6;
      p.outsideMeasuredProcessCpuMs=p.nativeCpuMs-p.row.processUserMs-p.row.processSystemMs;
      p.browserMain=browserMainCounterDelta(p.before,p.after,counterReady.timebase,p.row.threadUserMs+p.row.threadSystemMs);
    }
    result.sourceAfter=identity();result.sourceUnchanged=JSON.stringify(result.sourceBefore)===JSON.stringify(result.sourceAfter);
    result.readsValid=result.observation.reads.filter(row=>row.kind===target).every(row=>row.rows>0&&!row.readFailure
      &&(target!=='session'||row.evidence.length>0&&row.evidence.every(span=>span.rows>0)));
    result.countersAvailable=result.points.filter(point=>point.row.kind!=='noop').every(point=>BigInt(point.delta.ri_cycles)>0&&BigInt(point.delta.ri_instructions)>0);
    if(target==='session'){result.projectionMatched=new Set(result.observation.reads.filter(row=>row.kind==='session').map(row=>row.projectionSha256)).size===1;
      if(!result.projectionMatched)result.ok=false;}
    result.ok=result.ok&&result.readsValid&&result.countersAvailable&&result.sourceUnchanged&&result.observation.stopped&&result.observation.restored&&!result.observation.timedOut&&result.observation.backgroundDropped===0&&result.observation.background.every(row=>!row.metadataFailure)&&result.points.every(p=>p.processIdentityStable&&p.row.sourceStable&&p.row.sourceStamp===result.sourceBefore.stampSha256);
  }
  return result;
}
try{
  let supervisor,store;
  if(!isolationOnly){
  const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(1000)})).json();main=await connect(targets[0].webSocketDebuggerUrl);
  const identity=(await evaluate(main,'({pid:process.pid,electron:process.versions.electron,node:process.versions.node,uptime:process.uptime()})')).value;
  if(identity.pid!==pid||!identity.electron)throw new Error('main_pid_mismatch');verified=true;report.mainRuntime=identity;
  const ports=await readPortReferences(main.post.bind(main));supervisor=ports.find(row=>row.module==='SessionSupervisor').objectId;
  store=ports.find(row=>row.module==='GoalPlanStore').objectId;
  report.readPortDiscovery=ports.discovery;
  }
  if(mainOnly){
    await startCounters();report.mainOnly=true;
    if(mainPhases){
      report.phases=[];report.applicationPollingSuspended=false;
      for(const [name,delayMs]of [['dense-before',20],['probe-gap',counterIdleMs],['dense-after',20]]){
        const phase=await counterModeRead(main,store,pid,{supervisor,payload:mainPayload,phased:true,delayMs,label:name});report.phases.push({name,...phase});
      }
      report.sourceMatched=report.phases.every(p=>p.ok&&p.sourceBefore.sha256===report.phases[0].sourceBefore.sha256&&p.sourceBefore.stampSha256===report.phases[0].sourceBefore.stampSha256);
      report.ok=report.sourceMatched&&report.phases.every(p=>p.points.filter(x=>x.row.kind!=='noop').every(x=>x.browserMain.available));
      if(counterTarget==='session'){
        report.projectionMatched=new Set(report.phases.flatMap(p=>p.points.filter(x=>x.row.kind==='session').map(x=>x.row.projectionSha256))).size===1;
        report.ok=report.ok&&report.projectionMatched;
      }
    }else{
      report.main=await counterModeRead(main,store,pid,{supervisor,payload:mainPayload});
      report.sourceMatched=report.main.sourceUnchanged;report.ok=report.main.ok&&report.main.points.filter(p=>p.row.kind!=='noop').every(p=>p.browserMain.available);
    }
  }else{
  const config={moduleRoot,fixtureRoot,coordinationLiveRoot,coordinationSnapshot,parentHash:option('--parent-hash'),output,sourceStores:Boolean(coordinationLiveRoot),bindings:true,desktopDiagnostics:false,retainedCopies,startupOrder};
  const ready=path.join(output,'ready'),file=path.join(output,'fixture.private.cjs');
  fs.writeFileSync(file,`const{app}=require('electron');const fs=require('node:fs');app.setPath('userData',${JSON.stringify(path.join(output,'user-data'))});
    process.env.PEER_AGENT_HOME=${JSON.stringify(fixtureRoot)};process.env.PEER_AGENT_SLOW_TIMER_MS='0';
    app.whenReady().then(async()=>{const{guardReadOnlySource}=await import(${JSON.stringify(new URL('./ri00/readonly-coordination.mjs',import.meta.url).href)});
    const{createReadHost}=await import(${JSON.stringify(new URL('./ri00/read-host.mjs',import.meta.url).href)});
    const{createTrace}=await import(${JSON.stringify(new URL('./ri00/trace.mjs',import.meta.url).href)});
    const guard=guardReadOnlySource(${JSON.stringify(coordinationLiveRoot?path.dirname(coordinationLiveRoot):fixtureRoot)});
    globalThis.__ri00CpuHost=await createReadHost({...${JSON.stringify(config)},readOnlyGuard:guard,trace:createTrace({enabled:false})});
    const startupOrder=${JSON.stringify(startupOrder)};
    if(startupOrder!=='none'){
      const host=globalThis.__ri00CpuHost,counts={indexReads:0,sessionReads:0},readIndex=()=>{host.readPorts.goalPlanStore.listEvidenceIndex();counts.indexReads++;},readSession=()=>{host.sessionFacts();counts.sessionReads++;};
      if(startupOrder==='session-first')readSession();
      for(let i=0;i<8;i++)readIndex();
      if(startupOrder==='index-first')readSession();
      globalThis.__ri00CpuStartup={startupOrder,counts,retainedOutputCopies:0};
    }
    const copies=${JSON.stringify(retainedCopies)};
    if(copies!==null){
      const store=globalThis.__ri00CpuHost.readPorts.goalPlanStore,v8=require('node:v8'),file=store.getStoreDir()+'/evidence-index.jsonl';
      if(fs.statSync(file).size>128*1024*1024)throw Error('retention_input_too_large');
      const before=v8.getHeapStatistics(),retained=[];let rows=0;
      for(let i=0;i<8;i++){const output=store.listEvidenceIndex();if(output.length>100000)throw Error('retention_row_limit');rows=output.length;if(i<copies)retained.push(output);}
      globalThis.__ri00CpuRetainedIndexCopies=retained;
      globalThis.__ri00CpuRetention={kind:'synthetic-live-set-control-not-production-cache-identity',copies,normalizationCalls:8,rowsPerCopy:rows,retainedRows:copies*rows,heapBefore:before,heapAfter:v8.getHeapStatistics()};
    }
    globalThis.__ri00CpuGuard=guard;fs.writeFileSync(${JSON.stringify(ready)},'ready');
    app.on('will-quit',()=>{globalThis.__ri00CpuHost.close();guard.close();});
    }).catch(error=>{fs.writeFileSync(${JSON.stringify(path.join(output,'fixture-error.private.txt'))},error.stack);app.exit(1)});`,{mode:0o600});
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  child=spawn(require('electron'),['--inspect=0',...(engineFlags[engineExperiment]?[`--js-flags=${engineFlags[engineExperiment]}`]:[]),file],{env,stdio:['ignore','pipe','pipe']});let log='';
  child.stderr.on('data',bytes=>{log+=bytes;childStderr+=bytes;});
  child.stdout.on('data',bytes=>{if(childStdout.length+bytes.length<=16*1024*1024)childStdout+=bytes;else traceDropped+=bytes.length;});
  for(let i=0;i<200&&(!fs.existsSync(ready)||!log.match(/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/));i++)await wait(50);
  fs.writeFileSync(path.join(output,'child-stderr.private.txt'),log,{mode:0o600});
  if(!fs.existsSync(ready))throw new Error('fixture_not_ready');fixture=await connect(log.match(/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/)[0]);
  const payload=(await evaluate(fixture,'globalThis.__ri00CpuHost.payload')).value;
  const childSupervisor=(await evaluate(fixture,'globalThis.__ri00CpuHost.readPorts.supervisor',false)).objectId,
    childStore=(await evaluate(fixture,'globalThis.__ri00CpuHost.readPorts.goalPlanStore',false)).objectId;
  const fixturePid=(await evaluate(fixture,'process.pid')).value;if(fixturePid!==child.pid)throw new Error('fixture_pid_mismatch');
  report.fixtureRuntime=(await evaluate(fixture,'({node:process.versions.node,electron:process.versions.electron,v8:process.versions.v8,arch:process.arch,cachedDataVersionTag:process.getBuiltinModule("v8").cachedDataVersionTag()})')).value;
  if(retainedCopies!==null)report.retentionWorkload=(await evaluate(fixture,'globalThis.__ri00CpuRetention')).value;
  if(startupOrder!=='none')report.startupWorkload=(await evaluate(fixture,'globalThis.__ri00CpuStartup')).value;
  if(mode==='counters')await startCounters();
  if(isolationOnly){
    report.phases=[];
    if(mode==='ownership'||mode==='vm-state'){
      const inspect=mode==='ownership'?ownershipRead:vmStateRead;
      report.phases.push({name:'before-query',...await inspect(fixture,childStore)});
      await evaluate(fixture,'(async()=>{for(let i=0;i<12;i++)await globalThis.__ri00CpuHost.sessionFacts();return true;})()',true,true);
      report.phases.push({name:'after-12-queries',...await inspect(fixture,childStore)});
    }else{
    for(const [name,delayMs]of (hotOnly?[['hot-before',20]]:[['hot-before',20],['idle',counterIdleMs],['hot-recovery',20]])){
      const phase=await counterModeRead(fixture,childStore,fixturePid,{supervisor:childSupervisor,payload,delayMs,label:name});report.phases.push({name,...phase});
      console.log(JSON.stringify({stage:name,ok:phase.ok,readWallMs:phase.points.filter(point=>point.row.kind===counterTarget).map(point=>point.row.end-point.row.start)}));
    }
    }
    report.sourceMatched=report.phases.every(row=>row.ok&&row.sourceBefore.sha256===report.phases[0].sourceBefore.sha256&&row.sourceBefore.stampSha256===report.phases[0].sourceBefore.stampSha256);
    if(mode==='counters'&&counterTarget==='session'){
      report.projectionMatched=new Set(report.phases.flatMap(phase=>phase.points.filter(point=>point.row.kind==='session').map(point=>point.row.projectionSha256))).size===1;
      if(!report.projectionMatched)report.sourceMatched=false;
    }
  }else{
  const compare=async(session,supervisor,store,payload,pid,label)=>mode==='session'?profiledRead(session,supervisor,store,payload,label):mode==='cache'?cacheRead(session,store):mode==='ownership'?ownershipRead(session,store):mode==='vm-state'?vmStateRead(session,store):counterModeRead(session,store,pid,{supervisor,payload,label});
  report.mainA=await compare(main,supervisor,store,payload,pid,'main-a');
  if(mode==='ownership'||mode==='vm-state')await evaluate(fixture,'(async()=>{for(let i=0;i<12;i++)await globalThis.__ri00CpuHost.sessionFacts();return true;})()',true,true);
  report.fixture=await compare(fixture,childSupervisor,childStore,payload,fixturePid,'fixture');
  report.mainB=await compare(main,supervisor,store,payload,pid,'main-b');
  report.sourceMatched=[report.mainA,report.fixture,report.mainB].every(row=>row.ok&&row.sourceBefore.sha256===report.mainA.sourceBefore.sha256
    &&row.sourceBefore.stampSha256===report.mainA.sourceBefore.stampSha256);
  if(mode==='session')report.projectionMatched=new Set([report.mainA,report.fixture,report.mainB].flatMap(group=>group.reads.map(row=>row.projectionSha256))).size===1;
  if(mode==='counters'&&counterTarget==='session')report.projectionMatched=new Set([report.mainA,report.fixture,report.mainB].flatMap(group=>group.observation.reads.filter(row=>row.kind==='session').map(row=>row.projectionSha256))).size===1;
  }
  report.fixtureGuard=(await evaluate(fixture,'({...globalThis.__ri00CpuGuard.state})')).value;
  if(vmAfter){report.vmAfter=await vmStateRead(fixture,childStore,args.includes('--vm-debug-print'));if(!report.vmAfter.ok)throw new Error('post_query_vm_state_invalid');}
  report.fixtureReadFailures=(await evaluate(fixture,'globalThis.__ri00CpuHost.readFailures()')).value;
  report.ok=report.sourceMatched&&report.projectionMatched!==false&&report.fixtureReadFailures===0&&report.fixtureGuard.sourceWritesDenied===0;
  }
}catch(error){report.ok=false;report.failures.push({name:error.name,message:error.message});}
finally{
  if(counterProcess){for(const pending of counterPending.values()){clearTimeout(pending.timer);pending.reject(new Error('counter_sidecar_closing'));}counterPending.clear();counterProcess.stdin.end();counterProcess.kill('SIGTERM');}
  fixture?.socket.close();if(child){child.kill('SIGTERM');await new Promise(resolve=>child.exitCode==null?child.once('close',resolve):resolve());}
  fs.writeFileSync(path.join(output,'child-stdout.private.txt'),childStdout,{mode:0o600});fs.writeFileSync(path.join(output,'child-stderr.private.txt'),childStderr,{mode:0o600});
  report.traceDroppedBytes=traceDropped;if(traceDropped)report.ok=false;
  if(main){if(verified&&args.includes('--close-inspector'))try{await evaluate(main,'setTimeout(()=>process.getBuiltinModule("inspector").close(),250);true');}
    catch(error){report.failures.push({name:error.name,message:'inspector_close_failed'});}main.socket.close();}
  report.closeCheck=await inspectClosure(port,{required:verified&&args.includes('--close-inspector')});
  report.harnessUnchanged=JSON.stringify(report.harness)===JSON.stringify(harness());report.productionUnchanged=JSON.stringify(report.production)===JSON.stringify(productionIdentity(moduleRoot));
  if(isolationOnly){report.fixtureUnchanged=JSON.stringify(report.fixtureIdentity)===JSON.stringify(fixtureIdentity(fixtureRoot));
    report.snapshotUnchanged=!coordinationSnapshot||JSON.stringify(report.snapshotIdentity)===JSON.stringify(contentIdentity(coordinationSnapshot));
    if(!report.fixtureUnchanged||!report.snapshotUnchanged)report.ok=false;}
  if(report.failures.length||!report.harnessUnchanged||!report.productionUnchanged||verified&&args.includes('--close-inspector')&&!report.closeCheck.closed)report.ok=false;
  report.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(output,'report.private.json'),JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify({ok:report.ok,sourceMatched:report.sourceMatched,closeCheck:report.closeCheck,failures:report.failures}));if(!report.ok)process.exitCode=1;
}
