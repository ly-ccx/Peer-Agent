const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url'),{app}=require('electron');
const cfgFile=process.env.PEER_RI00_OWNED_CONFIG;
if(!cfgFile)throw Error('e3_owned_config_environment_required');
const cfg=JSON.parse(fs.readFileSync(cfgFile,'utf8'));
if(!cfg.output||!['production','functional'].includes(cfg.mode))throw Error('e3_owned_config_required');
app.setPath('userData',path.join(cfg.output,'user-data'));
if(cfg.fixtureRoot)process.env.PEER_AGENT_HOME=cfg.fixtureRoot;
process.env.PEER_AGENT_SLOW_TIMER_MS='0';
const send=x=>process.stdout.write('@ri00@'+JSON.stringify(x)+'\n');
let host,guard,probe,queue,originals,inspectorSession,spies,ports,closing=false,readCount=0,inject=false,clockRestore,functionalValue,lastOriginalValue,entries,entryGraph,site,siteCpuMs=0;
const qualification={order:[],errors:[],notFieldCause:true};
const binding='__ri00_e3_owned_notice';globalThis[binding]=()=>{};
const deadline=setTimeout(()=>app.exit(124),cfg.hostDeadlineMs||180000);deadline.unref();
async function install(){
 const {e3InstallerSource}=await import(pathToFileURL(path.join(__dirname,'e3-install.mjs')).href);
 const inspector=require('node:inspector');inspectorSession=new inspector.Session();inspectorSession.connect();
 globalThis.__e3InstallPorts=ports;
 const options={longWatch:true,eventLoopReads:true,exposureLedger:true,ownedExperiment:true,durationMs:cfg.hostDeadlineMs||180000,
  leaseMs:cfg.leaseMs||90000,readCpuLimitMs:cfg.readCpuLimitMs||60000,probeCpuLimitMs:5000,nativeCpuLimitMs:3000,
  notificationName:binding,closeInspectorOnWatchdog:cfg.closeInspectorOnWatchdog===true,
  ...(cfg.ownedCounterPath?{ownedPassCounterKey:'__ri00_owned_pass_counter'}:{}),
  queue:{owner:cfg.label,epoch:cfg.epoch,allowExposure:cfg.allowExposure===true}};
 globalThis.__e3InstallOptions=options;
 const post=(method,params)=>new Promise((resolve,reject)=>inspectorSession.post(method,params,(e,r)=>e?reject(e):resolve(r)));
 if(cfg.site&&cfg.mode==='production'){
  const {discoverE3Entries}=await import(pathToFileURL(path.join(__dirname,'e3-entry-discovery.mjs')).href);
  const {e3SiteCallDeclaration}=await import(pathToFileURL(path.join(__dirname,'e3-site-install.mjs')).href);
  const refs=await discoverE3Entries(post,{electronRequireBase:path.join(cfg.moduleRoot,'apps/desktop/package.json')});entryGraph.mapping=refs.proof;
  const reply=await post('Runtime.callFunctionOn',{objectId:refs.store,functionDeclaration:e3SiteCallDeclaration(),arguments:[{objectId:refs.supervisor},{value:ports.payload},{value:options},{objectId:refs.ports},{objectId:refs.directory}],returnByValue:true});
  if(reply.exceptionDetails)throw Error('e3_site_serialized_install_failed');
 }else{
  let expression;
  if(cfg.site){
   const {e3SiteInstallerSource}=await import(pathToFileURL(path.join(__dirname,'e3-site-install.mjs')).href);
   globalThis.__e3EntryBindings={entries:[...['list','get','listSessions','getSession','listObligationGrants'].map(key=>({object:entryGraph.application,key,kind:'ipc-'+key})),{object:entryGraph.directory,key:'list',kind:'directory-list'}],
    readers:[{object:ports.store,key:'getPlan',port:'plan',layered:true},{object:ports.store,key:'listEvidenceIndex',port:'index',layered:true},...['list','listByWorkspaceIds','get'].map(key=>({object:ports.supervisor,key,port:'supervisor-'+key,layered:key!=='get'}))]};
   expression=`globalThis.__e3Owned=(${e3SiteInstallerSource()}).call(globalThis.__e3InstallPorts.store,globalThis.__e3InstallPorts.supervisor,globalThis.__e3InstallPorts.payload,globalThis.__e3InstallOptions,globalThis.__e3EntryBindings);true`;
  }else expression=`globalThis.__e3Owned=(${e3InstallerSource()}).call(globalThis.__e3InstallPorts.store,globalThis.__e3InstallPorts.supervisor,globalThis.__e3InstallPorts.payload,globalThis.__e3InstallOptions);true`;
  const reply=await post('Runtime.evaluate',{expression,returnByValue:true});if(reply.exceptionDetails)throw Error('e3_serialized_install_failed');
 }
 inspectorSession.disconnect();inspectorSession=null;delete globalThis.__e3InstallPorts;delete globalThis.__e3InstallOptions;
 delete globalThis.__e3EntryBindings;site=globalThis.__e3Owned;({probe,queue,entries}=site);
}
function ownerState(){return {list:ports.supervisor.list===originals.list,index:ports.store.listEvidenceIndex===originals.index,
 plan:!originals.plan||ports.store.getPlan===originals.plan,...(cfg.site?{batch:ports.supervisor.listByWorkspaceIds===originals.batch,get:ports.supervisor.get===originals.get}:{})};}
function getterCounts(){return spies?{...spies.count}:null;}
async function finish(options={}){
 if(closing)return;closing=true;clockRestore?.();const stopped=probe?.stop();
 const report={stopped,owners:ownerState(),guard:guard?{...guard.state}:null,readFailures:host?.readFailures()||0,
  getters:getterCounts(),qualification,readCount,inspectorOpen:Boolean(require('node:inspector').url())};
 if(cfg.site){report.siteCpuMs=siteCpuMs;report.entryAdapter=entries?.state();report.mapping=entryGraph.mapping||null;report.proofScope=entryGraph.proofScope||null;}
 if(cfg.auditOnShutdown&&!options.skipAudit){
  if(!cfg.allowExposure||cfg.mode!=='production')throw Error('e3_owned_post_measurement_audit_required');
  const before=process.threadCpuUsage();
  try{const records=ports.store.listEvidenceIndex(),hash=require('node:crypto').createHash('sha256');for(const record of records)hash.update(JSON.stringify(record)+'\n');
   report.postMeasurementAudit={rows:records.length,sha256:hash.digest('hex'),notUsedForPerformance:true};
  }catch(error){report.postMeasurementAudit={failed:true,error:{name:error.name,message:error.message},notUsedForPerformance:true};}
  const cost=process.threadCpuUsage(before);report.postMeasurementAudit.cpuMs=(cost.user+cost.system)/1000;
  report.guard={...guard.state};report.readFailures=host.readFailures();
 }
 if(cfg.auditOnShutdown&&options.skipAudit)report.postMeasurementAudit={skipped:true,reason:'remaining-read-budget',cpuMs:0,notUsedForPerformance:true};
 fs.writeFileSync(path.join(cfg.output,'exit.private.json'),JSON.stringify(report),{mode:0o600});
 try{const logSink=entryGraph?.close();if(cfg.site&&logSink)report.logSink=logSink;host?.close();}finally{guard?.close();if(spies)for(const[n,fn]of Object.entries(spies.original))require('node:v8')[n]=fn;}
 fs.writeFileSync(path.join(cfg.output,'exit.private.json'),JSON.stringify(report),{mode:0o600});
 return report;
}
app.whenReady().then(async()=>{
 if(cfg.ownedCounterPath){if(!path.isAbsolute(cfg.ownedCounterPath)||!cfg.ownedCounterPath.endsWith('.node')||process.execPath.endsWith('/Peer Agent.app/Contents/MacOS/Peer Agent'))throw Error('e3_owned_counter_path_required');globalThis.__ri00_owned_pass_counter=require(cfg.ownedCounterPath);}
 if(cfg.mode==='production'){
  const {guardReadOnlySource}=await import(pathToFileURL(path.join(__dirname,'readonly-coordination.mjs')).href);
  const {createReadHost}=await import(pathToFileURL(path.join(__dirname,'read-host.mjs')).href);
  const {createTrace}=await import(pathToFileURL(path.join(__dirname,'trace.mjs')).href);
  guard=guardReadOnlySource([cfg.fixtureRoot,...(cfg.coordinationSnapshot?[path.dirname(cfg.coordinationSnapshot)]:[])]);
  host=await createReadHost({...cfg,bindings:true,desktopDiagnostics:false,readOnlyGuard:guard,trace:createTrace({enabled:false})});
  ports={store:host.readPorts.goalPlanStore,supervisor:host.readPorts.supervisor,payload:host.payload};
 }else{
  fs.writeFileSync(path.join(cfg.output,'evidence-index.jsonl'),'{}\n',{mode:0o600});const values=functionalValue=[{fixture:true}],data=[{}];
  ports={payload:{workspaceId:'owned-fixture'},store:{getStoreDir:()=>cfg.output,getPlan:()=>({fixture:true}),listEvidenceIndex:()=>data},supervisor:{list(input){
   readCount++;if(qualification.failRead)throw originalError;for(let i=0;i<12;i++){ports.store.getPlan();ports.store.listEvidenceIndex();}return values;}}};
 }
 const originalError=Error('e3_owned_original_error');
 if(cfg.spyGetters){const v8=require('node:v8'),names=['getHeapStatistics','getHeapSpaceStatistics','getHeapCodeStatistics'];spies={count:Object.fromEntries(names.map(n=>[n,0])),original:Object.fromEntries(names.map(n=>[n,v8[n]]))};for(const n of names)v8[n]=(...args)=>{spies.count[n]++;return spies.original[n](...args);};}
 if(cfg.nestedRequest||cfg.qualification){const listed=ports.supervisor.list;ports.supervisor.list=function(...args){
   if(qualification.failRead)throw originalError;
   qualification.order.push(inject?'outer-enter':'witness-enter');if(inject){inject=false;const before=probe.queueContext().controlledCpuMs;
    const accepted=queue.request({id:1,kind:'witness',label:'nested-witness'});qualification.queuedInsideOriginal=accepted.state==='queued';
    const result=lastOriginalValue=Reflect.apply(listed,this,args);qualification.noDiagnosticReadBeforeReturn=probe.queueContext().controlledCpuMs===before;
    qualification.order.push('outer-leave');return result;}
   const result=lastOriginalValue=Reflect.apply(listed,this,args);qualification.order.push('witness-leave');return result;};}
 if(cfg.site){
  if(cfg.mode==='production'){
   const before=process.threadCpuUsage(),selected=ports.supervisor.list(ports.payload),cost=process.threadCpuUsage(before);siteCpuMs+=(cost.user+cost.system)/1000;
   const {createE3EntryReadGraph}=await import(pathToFileURL(path.join(__dirname,'e3-entry-read-host.mjs')).href);
   entryGraph=await createE3EntryReadGraph(host,cfg,require('electron').ipcMain);entryGraph.sessionId=selected[0]?.sessionId;if(!entryGraph.sessionId)throw Error('e3_entry_fixture_session_missing');
  }else{
   ports.supervisor.listByWorkspaceIds=function(ids){return new Map(ids.map(id=>[id,ports.supervisor.list(ports.payload)]));};
   ports.supervisor.get=function(){return Promise.resolve(functionalValue[0]);};
   const directory={list:()=>ports.supervisor.listByWorkspaceIds(['owned-fixture']),get:()=>ports.supervisor.list(ports.payload)};
   const application={list:()=>directory.list(),get:()=>directory.get(),listSessions:()=>ports.supervisor.list(ports.payload),
    getSession:()=>{entryGraph.lastPromise=Promise.resolve().then(()=>application.get());return entryGraph.lastPromise;},listObligationGrants:()=>ports.supervisor.list(ports.payload)};
   const keys={'project-agent:list':'list','project-agent:get':'get','project-agent:list-sessions':'listSessions','project-agent:get-session':'getSession','project-agent:list-obligation-grants':'listObligationGrants'};
   entryGraph={directory,application,invoke(channel){if(!keys[channel])throw Error('e3_entry_read_only_channel_required');return application[keys[channel]]();},close(){}};
  }
 }
 originals={list:ports.supervisor.list,index:ports.store.listEvidenceIndex,plan:ports.store.getPlan,batch:ports.supervisor.listByWorkspaceIds,get:ports.supervisor.get,entry:entryGraph?.application.list};await install();
 const wait=ms=>new Promise(r=>setTimeout(r,ms));
 const commands={
  request:args=>queue.request(args),status:args=>queue.status(args.id),
  wait:async args=>{const end=Date.now()+15000;while(Date.now()<end){const t=queue.status(args.id);if(['completed','failed','expired','acknowledged'].includes(t.state))return t;await wait(2);}throw Error('e3_ticket_wait_timeout');},
  take:()=>probe.take(),ackBatch:()=>probe.ack(),ackTicket:args=>queue.ack(args.id),renew:()=>cfg.site?site.renew():probe.renew(),native:()=>probe.native(),vm:()=>probe.vm(),
  passCounter:args=>probe.setPassCounter(args.enabled),
  takeEntries:()=>{if(!cfg.site)throw Error('e3_site_required');return entries.take();},ackEntries:()=>{if(!cfg.site)throw Error('e3_site_required');return entries.ack();},
  entryInvoke:async args=>{if(!cfg.site)throw Error('e3_site_required');if(siteCpuMs+probe.queueContext().controlledCpuMs>=(cfg.siteReadCpuLimitMs||20000))throw Error('e3_site_read_cpu_budget');
   const before=process.threadCpuUsage();let value,samePromise;
   try{const result=args.channel==='directory-list'?entryGraph.directory.list():entryGraph.invoke(args.channel,{...ports.payload,sessionId:entryGraph.sessionId});samePromise=cfg.mode==='functional'&&args.channel==='project-agent:get-session'?result===entryGraph.lastPromise:null;value=await result;}
   finally{const cost=process.threadCpuUsage(before);siteCpuMs+=(cost.user+cost.system)/1000;}
   return {ok:cfg.mode==='functional'||args.channel==='directory-list'?true:value?.ok===true,samePromise,siteCpuMs};},
  inspect:()=>({context:probe.queueContext(),queue:queue.snapshot(),owners:ownerState(),getters:getterCounts(),qualification,readCount,guard:guard?{...guard.state}:null,
   readFailures:host?.readFailures()||0,inspectorOpen:Boolean(require('node:inspector').url()),...(cfg.site?{entryAdapter:entries.state(),mapping:entryGraph.mapping||null,siteCpuMs}:{})}),
  nested:()=>{inject=true;const result=ports.supervisor.list(ports.payload);return {rows:result.length,qualification,getters:getterCounts()};},
  fail:args=>{qualification.failRead=args.value;return true;},
  naturalError:()=>{try{if(cfg.site)entryGraph.application.listSessions(ports.payload);else ports.supervisor.list(ports.payload);}catch(e){return {sameError:e===originalError};}return {sameError:false};},
  naturalIdentity:()=>{const value=ports.supervisor.list(ports.payload);return {sameValue:value===(cfg.qualification?lastOriginalValue:functionalValue)};},
  expire:()=>{const performance=require('node:perf_hooks').performance,descriptor=Object.getOwnPropertyDescriptor(performance,'now');let now=performance.now();Object.defineProperty(performance,'now',{configurable:true,value:()=>now});
   clockRestore=()=>{if(descriptor)Object.defineProperty(performance,'now',descriptor);else delete performance.now;clockRestore=null;};const accepted=queue.request({id:3,kind:'witness',label:'expires',ttlMs:1});now+=2;return accepted;},
  restoreClock:()=>{clockRestore?.();return true;},
  replaceOwner:()=>{qualification.replacement=()=>[];ports.supervisor.list=qualification.replacement;return true;},
  replaceEntryOwner:()=>{if(!cfg.site||!cfg.qualification)throw Error('e3_owned_functional_entry_required');qualification.entryReplacement=()=>[];entryGraph.application.list=qualification.entryReplacement;return true;},
  stop:()=>probe.stop(),
  resetAfterOwnerTest:async args=>{qualification.ownerFailure=probe.stop();if(qualification.entryReplacement){qualification.lateEntryOwnerPreserved=entryGraph.application.list===qualification.entryReplacement;entryGraph.application.list=originals.entry;qualification.entryReplacement=null;}
   else qualification.lateOwnerPreserved=ports.supervisor.list===qualification.replacement;ports.supervisor.list=originals.list;if(args.leaseMs)cfg.leaseMs=args.leaseMs;globalThis[binding]=()=>{};await install();return true;},
  shutdown:async args=>{const report=await finish(args);setImmediate(()=>app.exit(0));return report;}
 };
 let buffered='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{buffered+=chunk;if(buffered.length>16384){app.exit(125);return;}let n;
  while((n=buffered.indexOf('\n'))>=0){const line=buffered.slice(0,n);buffered=buffered.slice(n+1);if(!line)continue;
   (async()=>{let request;try{request=JSON.parse(line);if(!commands[request.method]||!cfg.qualification&&['nested','fail','naturalError','naturalIdentity','expire','restoreClock','replaceOwner','resetAfterOwnerTest'].includes(request.method))throw Error('e3_owned_command_not_allowed');send({id:request.id,result:await commands[request.method](request.args||{})});}
    catch(e){send({id:request?.id,error:{name:e.name,message:e.message}});}})();}
 });
 process.stdin.once('end',()=>{finish({skipAudit:true}).finally(()=>app.exit(0));});
  send({event:'ready',pid:process.pid,performanceMs:require('node:perf_hooks').performance.now(),runtime:{node:process.versions.node,electron:process.versions.electron,v8:process.versions.v8,cachedDataVersionTag:require('node:v8').cachedDataVersionTag()},
  indexFile:path.join(ports.store.getStoreDir(),'evidence-index.jsonl'),sourceRevision:host?.sourceRevision(),inspectorUrl:require('node:inspector').url()});
}).catch(error=>{fs.writeFileSync(path.join(cfg.output,'bootstrap-error.private.txt'),error.stack,{mode:0o600});app.exit(1);});
