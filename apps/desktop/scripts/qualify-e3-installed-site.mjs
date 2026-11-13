import fs from'node:fs';import path from'node:path';import assert from'node:assert/strict';import{execFileSync}from'node:child_process';import{createHash}from'node:crypto';import{fileURLToPath}from'node:url';import{createRequire}from'node:module';
import{proveE3RegisteredSite}from'./ri00/e3-site-proof.mjs';import{inspectClosure}from'./ri00/trace.mjs';import{loopbackListenerPorts,newlyOwnedPorts}from'./ri00/inspector-port-owner.mjs';
const args=process.argv.slice(2),opt=k=>args[args.indexOf(k)+1];for(const k of['--pid','--output','--budget'])if(!args.includes(k))throw Error('installed_site_arguments');
const pid=Number(opt('--pid')),output=path.resolve(opt('--output')),budget=JSON.parse(fs.readFileSync(opt('--budget')));assert.equal(budget.kind,'E3-installed-metadata-only-budget');
if(!Number.isSafeInteger(pid)||pid<2||fs.existsSync(output))throw Error('installed_site_identity_or_output');
assert.equal(execFileSync('ps',['-p',String(pid),'-o','comm='],{encoding:'utf8'}).trim(),'/Applications/Peer Agent.app/Contents/MacOS/Peer Agent');
fs.mkdirSync(output,{recursive:true,mode:0o700});const hash=b=>createHash('sha256').update(b).digest('hex'),wait=ms=>new Promise(r=>setTimeout(r,ms)),root=fileURLToPath(new URL('../../../',import.meta.url));
const r={kind:'E3-installed-metadata-only-not-field',candidate:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),pid,startedAt:new Date().toISOString(),budgetSha256:hash(fs.readFileSync(opt('--budget'))),businessReads:0,nativeLoaded:false,wrappersInstalled:false,failures:[],passed:false};
const began=Date.now(),beforeCpu=process.cpuUsage();let ws,seq=0,opened=false,proof,port,inCleanup=false,discoveryChildWallUpperMs=0,globalKey='__ri00_site_metadata_deadline';const pending=new Map();
function ports(){const start=performance.now();try{return loopbackListenerPorts(execFileSync('lsof',['-nP','-a','-p',String(pid),'-iTCP','-sTCP:LISTEN','-Fn'],{encoding:'utf8',timeout:500,maxBuffer:65536}));}catch(e){if(e.status===1&&!String(e.stdout||'').trim())return[];throw e;}finally{discoveryChildWallUpperMs+=performance.now()-start;}}
const save=()=>fs.writeFileSync(path.join(output,'report.private.json'),JSON.stringify(r),{mode:0o600});
const post=(method,params={})=>new Promise((resolve,reject)=>{if(!inCleanup&&(Date.now()-began>30000||seq>=1000))return reject(Error('installed_site_wall_or_rpc_budget'));const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('installed_site_rpc_timeout'));},2000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
const evaluate=async expression=>{const x=await post('Runtime.evaluate',{expression,returnByValue:true});if(x.exceptionDetails)throw Error('installed_site_evaluate');return x.result.value;};
async function connect(url){ws=new WebSocket(url);await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('installed_site_websocket_timeout')),1000);ws.addEventListener('open',()=>{clearTimeout(timeout);resolve();},{once:true});ws.addEventListener('error',e=>{clearTimeout(timeout);reject(e);},{once:true});});
 ws.addEventListener('message',event=>{const value=JSON.parse(String(event.data)),p=pending.get(value.id);if(!p)return;pending.delete(value.id);clearTimeout(p.timer);value.error?p.reject(Error(value.error.message)):p.resolve(value.result);});}
try{
 const beforePorts=ports();r.beforePorts=beforePorts;
 const asar=createRequire(path.join(root,'apps/desktop/package.json'))('@electron/asar'),file='/Applications/Peer Agent.app/Contents/Resources/app.asar';
 const paths=['electron/main/ipc/catalog-ipc-main.mjs','electron/main/ipc/trusted-window-registry.mjs','electron/main/ipc/register-project-agent-ipc.mjs','electron/main/project-agent/project-agent-application-service.mjs','node_modules/@peer-agent/runtime-node/dist/project-agent/bot-directory.mjs'];
 r.installedModules=paths.map(relative=>({relative,sha256:hash(asar.extractFile(file,relative))}));r.asarStat={size:fs.statSync(file).size,mtimeMs:fs.statSync(file).mtimeMs};
 process.kill(pid,'SIGUSR1');opened=true;let endpoint;
 for(let i=0;i<10;i++){const fresh=newlyOwnedPorts(beforePorts,ports());for(const candidate of fresh){try{const response=await fetch(`http://127.0.0.1:${candidate}/json/list`,{signal:AbortSignal.timeout(300)}),list=await response.json();const node=list.find(x=>x.type==='node'&&x.webSocketDebuggerUrl);if(node){const u=new URL(node.webSocketDebuggerUrl);if(u.hostname!=='127.0.0.1'||Number(u.port)!==candidate)throw Error('installed_site_endpoint_owner');endpoint=node;port=candidate;break;}}catch(error){r.endpointDiscoveryError=error.message;}}if(endpoint)break;await wait(50);}
 r.actualPort=port;
 if(!endpoint?.webSocketDebuggerUrl)throw Error('installed_site_endpoint_missing');
 await connect(endpoint.webSocketDebuggerUrl);
 r.runtime=await evaluate(`(()=>{if(process.pid!==${pid})throw Error('site_pid_mismatch');if(Object.hasOwn(globalThis,${JSON.stringify(globalKey)}))throw Error('site_deadline_owner_exists');const c=process.threadCpuUsage();globalThis[${JSON.stringify(globalKey)}]={before:c,timer:setTimeout(()=>{delete globalThis[${JSON.stringify(globalKey)}];process.getBuiltinModule('inspector').close();},30000)};globalThis[${JSON.stringify(globalKey)}].timer.unref();return {node:process.versions.node,electron:process.versions.electron,v8:process.versions.v8};})()`);
 proof=await proveE3RegisteredSite(post);r.proof=proof.proof;r.functionSourceHashes=proof.handlers.map(h=>({key:h.key,sha256:hash(h.outerSource)}));r.authorizerSourceSha256=hash(proof.authorizationSource);
 // Repeat object discovery; no wrapper/global/probe is installed into the product graph.
 const second=await proveE3RegisteredSite(post);for(const k of['ports','directory','supervisor','store']){const x=await post('Runtime.callFunctionOn',{objectId:proof.refs[k],functionDeclaration:'function(b){return this===b;}',arguments:[{objectId:second.refs[k]}],returnByValue:true});assert.equal(x.result.value,true);}
 r.ownersStable=true;const s=fs.statSync(file);assert.equal(s.size,r.asarStat.size);assert.equal(s.mtimeMs,r.asarStat.mtimeMs);r.installedModulesUnchanged=paths.every((p,i)=>hash(asar.extractFile(file,p))===r.installedModules[i].sha256);assert.equal(r.installedModulesUnchanged,true);r.passed=true;
}catch(error){r.failures.push({message:error.message,stack:error.stack});}
finally{
 inCleanup=true;
 // Failure to discover/attach cannot be treated as proof that SIGUSR1 opened no listener.
 if(opened&&ws?.readyState!==WebSocket.OPEN)try{for(const candidate of newlyOwnedPorts(r.beforePorts||[],ports())){
   const response=await fetch(`http://127.0.0.1:${candidate}/json/list`,{signal:AbortSignal.timeout(500)}),list=await response.json(),node=list.find(x=>x.type==='node'&&x.webSocketDebuggerUrl);
   if(!node)continue;const u=new URL(node.webSocketDebuggerUrl);if(u.hostname!=='127.0.0.1'||Number(u.port)!==candidate)continue;
   await connect(node.webSocketDebuggerUrl);const identity=await evaluate(`process.pid===${pid}`);if(identity!==true)throw Error('installed_site_recovery_pid');port=candidate;r.actualPort=port;
   await evaluate(`(()=>{setTimeout(()=>process.getBuiltinModule('inspector').close(),100).unref();return true;})()`);r.recoveryOnly=true;break;
 }}catch(error){r.failures.push({message:'site_discovery_recovery:'+error.message});}
 if(ws?.readyState===WebSocket.OPEN&&!r.recoveryOnly)try{r.mainThreadWindowCpu=await evaluate(`(()=>{const s=globalThis[${JSON.stringify(globalKey)}];if(!s)throw Error('site_deadline_missing');const c=process.threadCpuUsage(s.before);clearTimeout(s.timer);delete globalThis[${JSON.stringify(globalKey)}];setTimeout(()=>process.getBuiltinModule('inspector').close(),100).unref();return {userMs:c.user/1000,systemMs:c.system/1000};})()`);}catch(error){r.failures.push({message:'site_cleanup:'+error.message});try{await evaluate(`(()=>{if(process.pid!==${pid})throw Error('cleanup_pid_mismatch');setTimeout(()=>process.getBuiltinModule('inspector').close(),100).unref();return true;})()`);}catch(e){r.failures.push({message:'site_cleanup_fallback:'+e.message});}}
 ws?.close();if(opened&&port)r.portClosure=await inspectClosure(port,{timeoutMs:Math.max(15000,35000-(Date.now()-began))});
 if(opened&&!r.portClosure?.closed){r.passed=false;r.failures.push({message:'installed_site_port_not_proven_closed'});}
 try{process.kill(pid,0);r.originalProcessAlive=true;}catch{r.originalProcessAlive=false;r.passed=false;}
 r.controllerCpu=process.cpuUsage(beforeCpu);r.discoveryChildWallCpuUpperMs=discoveryChildWallUpperMs;r.elapsedMs=Date.now()-began;r.commandCount=seq;r.finishedAt=new Date().toISOString();
 if(r.elapsedMs>45000||seq>1000||(r.controllerCpu.user+r.controllerCpu.system)/1000+discoveryChildWallUpperMs>2000||!r.mainThreadWindowCpu||r.mainThreadWindowCpu.userMs+r.mainThreadWindowCpu.systemMs>5000){r.passed=false;r.failures.push({message:'installed_site_budget_or_unknown_cost'});}
 if(r.failures.length)r.passed=false;save();console.log(JSON.stringify({passed:r.passed,proof:r.proof,elapsedMs:r.elapsedMs,commandCount:seq,controllerCpu:r.controllerCpu,mainThreadWindowCpu:r.mainThreadWindowCpu,portClosure:r.portClosure,failures:r.failures.map(e=>e.message)}));
}
