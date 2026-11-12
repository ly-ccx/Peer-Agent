import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { installStartupReadOrder } from './ri00/startup-read-order.mjs';
import { inspectClosure } from './ri00/trace.mjs';
import { resolveDestination } from './ri00/identity.mjs';

// This driver never launches, quits, restarts or installs an app. A separately
// authorized launcher must supply a fresh process waiting at --inspect-brk.
const args=process.argv.slice(2),option=(key,fallback)=>args.includes(key)?args[args.indexOf(key)+1]:fallback;
for(const key of ['--pid','--port','--expected-executable','--store-root','--output'])if(!option(key))throw new Error('explicit_startup_identity_required');
const pid=Number(option('--pid')),port=Number(option('--port')),durationMs=Number(option('--duration-ms','30000')),
  expectedExecutable=fs.realpathSync(option('--expected-executable')),storeRoot=path.resolve(option('--store-root')),canonicalStoreRoot=fs.realpathSync(storeRoot),output=resolveDestination(option('--output'));
if(!Number.isInteger(pid)||pid<1||!Number.isInteger(port)||port<1024||port>65535||!Number.isInteger(durationMs)||durationMs<100||durationMs>60000)throw new Error('bounded_startup_target_required');
if(output===canonicalStoreRoot||output.startsWith(canonicalStoreRoot+path.sep)||fs.existsSync(output))throw new Error('new_private_output_required');
fs.mkdirSync(output,{recursive:true,mode:0o700});fs.chmodSync(output,0o700);
const harness=()=>['observe-runtime-startup.mjs','ri00/startup-read-order.mjs','ri00/trace.mjs','ri00/identity.mjs'].map(relative=>({relative,sha256:createHash('sha256').update(fs.readFileSync(new URL(relative,import.meta.url))).digest('hex')}));
const report={kind:'startup-read-order-not-a-performance-fix',startedAt:new Date().toISOString(),harness:harness(),failures:[]};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));let socket,sequence=0,verified=false,paused=false,installed=false,waiting=true;
const pending=new Map();let pausedResolve;const firstPause=new Promise(resolve=>{pausedResolve=resolve;});
function post(method,params={}){if(socket?.readyState!==WebSocket.OPEN)return Promise.reject(new Error('startup_inspector_not_connected'));return new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('startup_inspector_timeout'));},10000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression){const r=await post('Runtime.evaluate',{expression,returnByValue:true});if(r.exceptionDetails)throw new Error('startup_evaluation_failed');return r.result.value;}
try{
  const executable=execFileSync('ps',['-p',String(pid),'-o','comm='],{encoding:'utf8'}).trim();
  const command=execFileSync('ps',['-p',String(pid),'-o','command='],{encoding:'utf8'});
  if(fs.realpathSync(executable)!==expectedExecutable||!new RegExp(`--inspect-brk=(?:127\\.0\\.0\\.1:)?(?:${port}|0)(?:\\s|$)`).test(command))throw new Error('fresh_startup_os_identity_required');
  const owners=execFileSync('/usr/sbin/lsof',['-nP',`-iTCP:${port}`,'-sTCP:LISTEN','-t'],{encoding:'utf8'}).trim().split(/\s+/);
  if(owners.length!==1||Number(owners[0])!==pid)throw new Error('startup_port_owner_mismatch');
  verified=true;report.osIdentityVerified=true;
  const targets=await new Promise((resolve,reject)=>{
    const req=http.get({host:'127.0.0.1',port,path:'/json/list',agent:false,timeout:1000},res=>{
      let text='';res.setEncoding('utf8');
      res.on('data',x=>{text+=x;if(text.length>100000)req.destroy(new Error('inspector_target_limit'));});
      res.on('end',()=>{try{resolve(JSON.parse(text));}catch{reject(new Error('invalid_inspector_targets'));}});
    });
    req.on('timeout',()=>req.destroy(new Error('inspector_target_timeout')));req.on('error',reject);
  });
  const endpoint=targets[0]?.webSocketDebuggerUrl;if(!endpoint?.startsWith(`ws://127.0.0.1:${port}/`))throw new Error('loopback_startup_inspector_required');
  socket=new WebSocket(endpoint);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  socket.onmessage=event=>{const r=JSON.parse(event.data);if(r.method==='Debugger.paused'){paused=true;pausedResolve(r.params);}if(r.method==='Debugger.resumed')paused=false;
    const p=pending.get(r.id);if(p){pending.delete(r.id);clearTimeout(p.timer);r.error?p.reject(new Error('startup_inspector_reply_failed')):p.resolve(r.result);}};
  socket.onclose=()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('startup_inspector_disconnected'));}pending.clear();};
  await post('Debugger.enable');await post('Runtime.runIfWaitingForDebugger');waiting=false;
  let pauseTimer;const pause=await Promise.race([firstPause,new Promise((_,reject)=>{pauseTimer=setTimeout(()=>reject(new Error('fresh_break_on_start_required')),3000);})]);clearTimeout(pauseTimer);
  if(pause.reason!=='Break on start')throw new Error('fresh_break_on_start_required');report.breakOnStart=true;
  const identity=await evaluate('({pid:process.pid,executable:process.execPath,electron:process.versions.electron,v8:process.versions.v8,node:process.versions.node,uptime:process.uptime()})');
  if(identity.pid!==pid||identity.executable!==expectedExecutable||!identity.electron)throw new Error('startup_process_identity_mismatch');report.runtime=identity;
  report.install=await evaluate(`(()=>{if(globalThis.__peerRi00StartupProbe)throw Error('startup_probe_owner_exists');
    const builtin=name=>process.getBuiltinModule(name),deps={fs:builtin('fs'),path:builtin('path'),timers:builtin('timers'),now:()=>Number(process.hrtime.bigint())/1e6,syncExports:()=>builtin('module').syncBuiltinESMExports()};
    const probe=(${installStartupReadOrder.toString()})(deps,{storeRoot:${JSON.stringify(storeRoot)},durationMs:${durationMs}});globalThis.__peerRi00StartupProbe=probe;
    globalThis.__peerRi00StartupCloseTimer=setTimeout(()=>{probe.stop();delete globalThis.__peerRi00StartupProbe;delete globalThis.__peerRi00StartupCloseTimer;builtin('inspector').close();},${durationMs+10000});globalThis.__peerRi00StartupCloseTimer.unref?.();return {installed:true};})()`);
  installed=true;await post('Debugger.resume');paused=false;await post('Debugger.disable');
  for(let elapsed=0;elapsed<durationMs;elapsed+=Math.min(1000,durationMs-elapsed))await wait(Math.min(1000,durationMs-elapsed));
  report.observation=await evaluate('globalThis.__peerRi00StartupProbe.stop()');
}catch(error){report.failures.push({name:error.name,message:error.message});}
finally{
  if(verified){
    if(waiting)await post('Runtime.runIfWaitingForDebugger').catch(()=>{});
    if(paused)await post('Debugger.resume').catch(()=>{});
    if(installed)try{report.observation=await evaluate('(()=>{const result=globalThis.__peerRi00StartupProbe?.stop();clearTimeout(globalThis.__peerRi00StartupCloseTimer);delete globalThis.__peerRi00StartupProbe;delete globalThis.__peerRi00StartupCloseTimer;return result})()');}catch{report.failures.push({message:'startup_stop_not_acknowledged'});}
    await evaluate('setTimeout(()=>process.getBuiltinModule("inspector").close(),250);true').catch(()=>{report.failures.push({message:'startup_inspector_close_not_acknowledged'});});
  }
  socket?.close();report.closeCheck=await inspectClosure(port,{required:verified});report.harnessUnchanged=JSON.stringify(report.harness)===JSON.stringify(harness());
  report.ok=report.failures.length===0&&report.breakOnStart&&report.observation?.stopped&&report.observation?.restored===true&&report.observation?.counts.index>0&&report.observation?.counts.plan>0&&report.observation?.classificationLimitHits===0&&report.closeCheck.closed&&report.harnessUnchanged;
  report.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(output,'report.private.json'),JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify({ok:report.ok,counts:report.observation?.counts,closed:report.closeCheck.closed,failures:report.failures}));if(!report.ok)process.exitCode=1;
}
