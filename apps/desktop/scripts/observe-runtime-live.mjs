import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { installObservation } from './ri00/live-observation.mjs';
import { inspectorValue, inspectClosure } from './ri00/trace.mjs';
import { profileClock } from './ri00/profile-clock.mjs';
import { observeGc } from './ri00/gc-observation.mjs';
import { readPortReferences } from './ri00/inspector-read-ports.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const pid = Number(option('--pid'));
const port = Number(option('--port', '9229'));
const durationMs = Number(option('--duration-ms', '600000'));
if (!Number.isInteger(pid) || pid < 1 || !Number.isInteger(port) || port < 1024 || port > 65535
  || !Number.isInteger(durationMs) || durationMs < 1000 || durationMs > 1200000) throw new Error('invalid_capture_options');
const output = option('--output');
if (!output || !fs.existsSync(output) || fs.readdirSync(output).length) throw new Error('explicit_empty_output_required');
fs.chmodSync(output, 0o700);
const workspaceIds = option('--workspace-file') ? JSON.parse(fs.readFileSync(option('--workspace-file'), 'utf8')) : [];
if (!Array.isArray(workspaceIds) || workspaceIds.some(id => typeof id !== 'string')) throw new Error('invalid_workspace_file');
const ownsInspector = args.includes('--close-inspector');
if(args.includes('--paired-path')&&!args.includes('--inspect-path'))throw new Error('paired_path_requires_path_observation');
if(args.includes('--unattributed-read-roots')&&!args.includes('--inspect-read-ports'))throw new Error('read_roots_require_read_ports');
const harness = () => ['observe-runtime-live.mjs','ri00/live-observation.mjs','ri00/trace.mjs','ri00/profile-clock.mjs','ri00/gc-observation.mjs','ri00/inspector-read-ports.mjs'].map(relative => ({relative,
  sha256:createHash('sha256').update(fs.readFileSync(new URL(relative,import.meta.url))).digest('hex')}));
const report = { kind: 'natural-live-observation-not-a-fix', startedAt: new Date().toISOString(),
  harnessSha256: createHash('sha256').update(fs.readFileSync(new URL('./ri00/live-observation.mjs', import.meta.url))).digest('hex'),
  harness: harness(), deepBuiltins: !args.includes('--no-builtins'),
  failures: [], ownsInspector, profileRequested: !args.includes('--no-profile') };
report.unattributedReadRoots = args.includes('--unattributed-read-roots');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket, next = 0, pending = new Map(), installed = false, profiling = false, requestedStop = false, verifiedTarget = false;
function post(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(new Error(`inspector_timeout:${method}`)); }, 30000);
    pending.set(id, { resolve(value) { clearTimeout(timer); resolve(value); }, reject(error) { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
const evaluate = async expression => inspectorValue(await post('Runtime.evaluate', { expression, returnByValue: true }));
async function clockMarker(name) {
  return evaluate(`(function ${name}(){const clock=()=>Number(process.hrtime.bigint())/1e6;const start=clock();let value=0;while(clock()-start<25)value+=Math.sqrt(value+1);return {name:${JSON.stringify(name)},start,end:clock()};})()`);
}
process.on('SIGINT', () => { requestedStop = true; });
process.on('SIGTERM', () => { requestedStop = true; });
try {
  // This collector never signals, launches or restarts an application. Attach only to an existing loopback inspector.
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })).json();
  socket = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const reply = JSON.parse(event.data), request = pending.get(reply.id); if (!request) return;
    pending.delete(reply.id); if (reply.error) request.reject(new Error(reply.error.message)); else request.resolve(reply.result);
  };
  socket.onclose = () => { for (const request of pending.values()) request.reject(new Error('inspector_disconnected')); pending.clear(); };
  report.runtime = await evaluate('({pid:process.pid,electron:process.versions.electron,node:process.versions.node,arch:process.arch,platform:process.platform})');
  if (report.runtime.pid !== pid || !report.runtime.electron) throw new Error('target_pid_or_host_mismatch');
  verifiedTarget = true;
  const readPorts = args.includes('--inspect-read-ports') ? await readPortReferences(post) : [];
  report.readModules = readPorts.map(port=>port.module);
  report.readPortDiscovery = readPorts.discovery;
  const dependencyExpression = `(()=>{
    if(globalThis.__peerRi00Observation)throw Error('observer_owner_exists');
    const builtin=process.getBuiltinModule;
    const require=builtin('module').createRequire(${option('--package-json') ? JSON.stringify(path.resolve(option('--package-json'))) : "process.resourcesPath+'/app.asar/package.json'"});
    const binding=require('@peer-agent/runtime-node/work-budget').workBudgetBinding;
    const crypto=builtin('crypto');
    const stores=${JSON.stringify(workspaceIds)}.map(id=>binding(id)?.store).filter(Boolean);
    const deps={ipcMain:require('electron').ipcMain,fs:builtin('fs'),json:JSON,
      phase:require('@peer-agent/runtime-node/diagnostic-phase'),stores,timerHosts:[globalThis,builtin('timers')],
      scopeOf:payload=>Object.fromEntries(['workspaceId','parentConversationId','sessionId'].filter(key=>typeof payload?.[key]==='string').map(key=>[key,crypto.createHash('sha256').update(payload[key]).digest('hex')])),
      timers:builtin('timers'),syncExports:()=>builtin('module').syncBuiltinESMExports(),
      AsyncLocalStorage:builtin('async_hooks').AsyncLocalStorage,now:()=>Number(process.hrtime.bigint())/1e6,wall:()=>new Date().toISOString()};
    globalThis.__peerRi00Observation=(${installObservation.toString()})(deps,{durationMs:${durationMs},limit:20000,deepBuiltins:${!args.includes('--no-builtins')},
      onWatchdog:()=>{${ownsInspector ? "setTimeout(()=>builtin('inspector').close(),1000)" : ''}}});
    try {const perf=builtin('perf_hooks');
      globalThis.__peerRi00Observation.gc=(${observeGc.toString()})({PerformanceObserver:perf.PerformanceObserver,performance:perf.performance,now:deps.now,wall:deps.wall,timers:builtin('timers')},${durationMs+30000});
    }catch(error){globalThis.__peerRi00Observation.stop();delete globalThis.__peerRi00Observation;throw error;}
    return {stores:stores.length,channels:deps.ipcMain._invokeHandlers.size,at:new Date().toISOString()};
  })()`;
  const installStarted = performance.now();
  report.install = await evaluate(dependencyExpression); installed = true;
  report.instrumentedReadMethods = 0;
  for(const port of readPorts) {
    report.instrumentedReadMethods += inspectorValue(await post('Runtime.callFunctionOn',{objectId:port.objectId,
      functionDeclaration:'function(module,methods,options){return globalThis.__peerRi00Observation.instrumentObject(this,module,methods,options)}',
      arguments:[{value:port.module},{value:port.methods},{value:{rootWhenUnattributed: report.unattributedReadRoots && port.module==='SessionSupervisor'}}],returnByValue:true}));
  }
  if(args.includes('--inspect-path')) {
    const pathObject=await post('Runtime.evaluate',{expression:'process.getBuiltinModule("path")',objectGroup:'ri00-path'});
    if(pathObject.exceptionDetails||!pathObject.result?.objectId)throw new Error('path_port_unavailable');
    report.instrumentedReadMethods+=inspectorValue(await post('Runtime.callFunctionOn',{objectId:pathObject.result.objectId,
      functionDeclaration:'function(){return globalThis.__peerRi00Observation.instrumentObject(this,"Path",["join","normalize","resolve"])}',returnByValue:true}));
    await post('Runtime.releaseObjectGroup',{objectGroup:'ri00-path'});
  }
  if(readPorts.length) await post('Runtime.releaseObjectGroup',{objectGroup:'ri00-read-ports'});
  report.installAckMs = performance.now() - installStarted;
  const adoptStarted = performance.now();
  if(!args.includes('--skip-existing-timers')) {
  const prototype = await post('Runtime.evaluate', { expression: 'globalThis.__peerRi00Observation.ownTimerPrototype', objectGroup: 'ri00-timers' });
  if (!prototype.result?.objectId) throw new Error('timer_prototype_unavailable');
  const objects = await post('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId, objectGroup: 'ri00-timers' });
  const adopted = await post('Runtime.callFunctionOn', { objectId: objects.objects.objectId,
    functionDeclaration: 'function(){return globalThis.__peerRi00Observation.adoptTimers(this)}', returnByValue: true });
  report.adoptedExistingTimers = inspectorValue(adopted);
  report.timerAdoptionAckMs = performance.now() - adoptStarted;
  await post('Runtime.releaseObjectGroup', { objectGroup: 'ri00-timers' });
  } else {report.adoptedExistingTimers=0;report.timerAdoptionAckMs=0;}
  report.naturalStart = await evaluate('(()=>{const s=globalThis.__peerRi00Observation.peek();s.naturalStartMono=Number(process.hrtime.bigint())/1e6;s.naturalStartAt=new Date().toISOString();return {mono:s.naturalStartMono,at:s.naturalStartAt}})()');
  if (report.profileRequested) {
    await post('Profiler.enable'); await post('Profiler.setSamplingInterval', { interval: 1000 });
    report.profileMainBefore = await evaluate('Number(process.hrtime.bigint())/1e6');
    await post('Profiler.start'); profiling = true;
    report.profileMainAfter = await evaluate('Number(process.hrtime.bigint())/1e6');
    report.clockMarkers = [await clockMarker('ri00ClockMarkerStart')];
  }
  console.log(JSON.stringify({ installed: true, ...report.install, existingTimers: report.adoptedExistingTimers }));
  const deadline = Date.now() + durationMs;
  const captureStarted = Date.now(); let phaseStage = -1;
  while (!requestedStop && Date.now() < deadline) {
    if(args.includes('--paired-phase')||args.includes('--paired-path')) {
      const nextStage = Math.min(3,Math.floor((Date.now()-captureStarted)/(durationMs/4)));
      if(nextStage!==phaseStage) {phaseStage=nextStage; const enabled=phaseStage===0||phaseStage===3;
        await evaluate(args.includes('--paired-path')?`globalThis.__peerRi00Observation.setModuleCapture("Path",${enabled});true`:`globalThis.__peerRi00Observation.setPhaseCapture(${enabled});true`);}
    }
    await wait(Math.min(30000, deadline - Date.now()));
    if (option('--stop-file') && fs.existsSync(option('--stop-file'))) break;
    const progress = await evaluate('(()=>{const s=globalThis.__peerRi00Observation.peek();return {at:new Date().toISOString(),records:s.records.length,gaps:s.gaps.length,maxGap:Math.max(0,...s.gaps.map(g=>g.gapMs)),stopped:s.stopped,dropped:s.dropped}})()');
    fs.writeFileSync(path.join(output, 'progress.json'), JSON.stringify(progress), { mode: 0o600 });
    console.log(JSON.stringify(progress)); if (progress.stopped) break;
  }
} catch (error) { report.failures.push(error.message); }
finally {
  if (socket?.readyState === WebSocket.OPEN) {
    if (profiling) try {
      report.clockMarkers.push(await clockMarker('ri00ClockMarkerStop'));
      const { profile } = await post('Profiler.stop'); profiling = false;
      fs.writeFileSync(path.join(output, 'main.private.cpuprofile'), JSON.stringify(profile), { mode: 0o600 });
      await post('Profiler.disable');
      report.profileClock = profileClock(profile, report.clockMarkers);
      report.profileSamples = profile.samples?.length;
    } catch (error) { report.failures.push(`profile_stop:${error.message}`); }
    if (installed) try { report.gc = await evaluate('globalThis.__peerRi00Observation.gc.stop()'); report.observation = await evaluate('globalThis.__peerRi00Observation.stop()'); }
    catch (error) { report.failures.push(`restore:${error.message}`); }
    if (verifiedTarget) try {
      await evaluate(`delete globalThis.__peerRi00Observation;${ownsInspector ? "setTimeout(()=>process.getBuiltinModule('inspector').close(),250);" : ''}true`);
    } catch (error) { report.failures.push(`close:${error.message}`); }
    socket.close();
  }
  report.closeCheck = await inspectClosure(port, { required: ownsInspector && verifiedTarget });
  report.inspectorClosed = report.closeCheck.closed;
  report.ok = report.failures.length === 0 && Boolean(report.observation?.restored?.every(Boolean))
    && (!ownsInspector || report.inspectorClosed) && !profiling;
  report.harnessUnchangedDuringRun = JSON.stringify(report.harness) === JSON.stringify(harness());
  if(!report.harnessUnchangedDuringRun) report.ok=false;
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(output, 'report.private.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ok: report.ok, inspectorClosed: report.inspectorClosed, failures: report.failures }));
  if (!report.ok) process.exitCode = 1;
}
