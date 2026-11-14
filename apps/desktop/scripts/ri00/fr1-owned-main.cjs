const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url'),{app,ipcMain}=require('electron');
const cfg=JSON.parse(fs.readFileSync(process.env.PEER_RI00_OWNED_CONFIG,'utf8'));if(!cfg.fr1Functional)throw Error('fr1_owned_only');
app.setPath('userData',path.join(cfg.output,'user-data'));process.env.PEER_AGENT_HOME=cfg.fixtureRoot;process.env.PEER_AGENT_SLOW_TIMER_MS='0';
let host,guard,graph,selected,queryCalls=0,readCpuMs=0,closed=false;const originalError=Error('fr1-original-owned-error');
const originalPromise=Promise.resolve({original:true});let originals;
const v8=require('node:v8'),getterCounts={},getterOriginal={};for(const n of ['getHeapStatistics','getHeapSpaceStatistics','getHeapCodeStatistics']){getterOriginal[n]=v8[n];getterCounts[n]=0;v8[n]=(...a)=>{getterCounts[n]++;return getterOriginal[n](...a);};}
const send=x=>process.stdout.write('@ri00@'+JSON.stringify(x)+'\n'),deadline=setTimeout(()=>app.exit(124),60000);deadline.unref();
app.whenReady().then(async()=>{
 const load=n=>import(pathToFileURL(path.join(__dirname,n)).href);
 const[{createReadHost},{guardReadOnlySource},{createTrace},{createE3EntryReadGraph}]=await Promise.all([load('read-host.mjs'),load('readonly-coordination.mjs'),load('trace.mjs'),load('e3-entry-read-host.mjs')]);
 guard=guardReadOnlySource([cfg.fixtureRoot,path.dirname(cfg.coordinationSnapshot)]);
 host=await createReadHost({...cfg,bindings:true,desktopDiagnostics:false,readOnlyGuard:guard,trace:createTrace({enabled:false})});
 const before=process.threadCpuUsage();selected=host.readPorts.supervisor.list(host.payload);let c=process.threadCpuUsage(before);queryCalls++;readCpuMs+=(c.user+c.system)/1000;
 graph=await createE3EntryReadGraph(host,cfg,ipcMain);const sessionId=selected[0]?.sessionId;if(!sessionId)throw Error('fr1_fixture_session');selected=null;
 originals={list:host.readPorts.supervisor.list,index:host.readPorts.goalPlanStore.listEvidenceIndex,plan:host.readPorts.goalPlanStore.getPlan,
  batch:host.readPorts.supervisor.listByWorkspaceIds,get:host.readPorts.supervisor.get,handlers:new Map(ipcMain._invokeHandlers)};
 globalThis.__fr1OwnedChecks={asyncValue(){return originalPromise;},throwOriginal(){throw originalError;},block(){const end=performance.now()+1300;while(performance.now()<end){}return {notFieldCause:true};}};
 const owners=()=>({list:host.readPorts.supervisor.list===originals.list,index:host.readPorts.goalPlanStore.listEvidenceIndex===originals.index,
  plan:host.readPorts.goalPlanStore.getPlan===originals.plan,batch:host.readPorts.supervisor.listByWorkspaceIds===originals.batch,get:host.readPorts.supervisor.get===originals.get,
  handlers:[...originals.handlers].every(([k,v])=>ipcMain._invokeHandlers.get(k)===v)});
 async function shutdown(){if(closed)return;closed=true;const state=globalThis.__ri00Fr1?.stop('controller');
  const r={state,owners:owners(),queryCalls,readCpuMs,getters:getterCounts,guard:guard.state,readFailures:host.readFailures()};
  graph.close();host.close();guard.close();for(const n in getterOriginal)v8[n]=getterOriginal[n];delete globalThis.__fr1OwnedChecks;
  fs.writeFileSync(path.join(cfg.output,'exit.private.json'),JSON.stringify(r),{mode:0o600});return r;}
 const commands={
  async entry({kind}){if(queryCalls>=12)throw Error('fr1_owned_query_cap');if(readCpuMs>=8000)throw Error('fr1_owned_read_cpu_cap');queryCalls++;const b=process.threadCpuUsage();
   try{if(kind==='directory')return {ok:Boolean(await graph.directory.list()),queryCalls};
    const channel=kind==='get-session'?'project-agent:get-session':'project-agent:list-sessions';const value=await graph.invoke(channel,{...host.payload,sessionId});return {ok:value?.ok===true,queryCalls};}
   finally{const c=process.threadCpuUsage(b);readCpuMs+=(c.user+c.system)/1000;}
  },
  checks(){let sameError=false;try{globalThis.__fr1OwnedChecks.throwOriginal();}catch(e){sameError=e===originalError;}return {samePromise:globalThis.__fr1OwnedChecks.asyncValue()===originalPromise,sameError};},
  block:()=>globalThis.__fr1OwnedChecks.block(),inspect:()=>({owners:owners(),queryCalls,readCpuMs,getters:getterCounts,guard:guard.state,state:globalThis.__ri00Fr1?.state()}),
  shutdown:async()=>{const r=await shutdown();setImmediate(()=>app.exit(0));return r;}
 };
 let buffered='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{buffered+=chunk;if(buffered.length>16384)return app.exit(125);let n;
  while((n=buffered.indexOf('\n'))>=0){const line=buffered.slice(0,n);buffered=buffered.slice(n+1);if(!line)continue;let x;try{x=JSON.parse(line);if(!commands[x.method])throw Error('fr1_owned_operation');Promise.resolve(commands[x.method](x.args||{})).then(result=>send({id:x.id,result}),e=>send({id:x.id,error:{message:e.message}}));}catch(e){send({id:x?.id,error:{message:e.message}});}}
 });process.stdin.once('end',()=>shutdown().finally(()=>app.exit(0)));
 send({event:'ready',pid:process.pid,inspectorUrl:require('node:inspector').url(),runtime:{node:process.versions.node,electron:process.versions.electron,v8:process.versions.v8},scopeWorkspace:host.payload.workspaceId,bootstrapReadCpuMs:readCpuMs});
}).catch(e=>{fs.writeFileSync(path.join(cfg.output,'bootstrap-error.private.txt'),e.stack,{mode:0o600});app.exit(1);});
