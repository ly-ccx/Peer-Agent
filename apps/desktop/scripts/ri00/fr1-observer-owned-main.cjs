const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url'),{app}=require('electron');
const cfg=JSON.parse(fs.readFileSync(process.env.PEER_RI00_OWNED_CONFIG,'utf8'));
if(!cfg.fr1ObserverControl)throw Error('observer_owned_config');
app.setPath('userData',path.join(cfg.output,'user-data'));process.env.PEER_AGENT_HOME=cfg.fixtureRoot;process.env.PEER_AGENT_SLOW_TIMER_MS='0';
const started=performance.now(),watchdog=setTimeout(()=>app.exit(124),25000);watchdog.unref();
const send=x=>process.stdout.write('@ri00@'+JSON.stringify(x)+'\n');let host,guard,value,ran=false,closed=false,queryCalls=0,readCpuMs=0,bytesWritten=0;
const v8=require('node:v8'),getterCounts={},originalGetters={};
for(const n of ['getHeapStatistics','getHeapSpaceStatistics','getHeapCodeStatistics']){originalGetters[n]=v8[n];getterCounts[n]=0;v8[n]=(...a)=>{getterCounts[n]++;return originalGetters[n](...a);};}
async function shutdown(){if(closed)return;closed=true;value=null;host?.close();guard?.close();for(const n in originalGetters)v8[n]=originalGetters[n];clearTimeout(watchdog);
 const r={queryCalls,readCpuMs,getters:getterCounts,guard:guard?.state,hostClosed:true,privateValueReleased:value===null,recorderInstallations:0,inspectorOpen:require('node:inspector').url()!==undefined};
 fs.writeFileSync(path.join(cfg.output,'exit.private.json'),JSON.stringify(r),{flag:'wx',mode:0o600});return r;}
app.whenReady().then(async()=>{
 const load=n=>import(pathToFileURL(path.join(__dirname,n)).href);
 const[{createReadHost},{guardReadOnlySource},{createTrace},{runFr1ObserverControls}]=await Promise.all([load('read-host.mjs'),load('readonly-coordination.mjs'),load('trace.mjs'),load('fr1-observer-controls.mjs')]);
 guard=guardReadOnlySource([cfg.fixtureRoot,path.dirname(cfg.coordinationSnapshot)]);
 host=await createReadHost({...cfg,bindings:true,desktopDiagnostics:false,readOnlyGuard:guard,trace:createTrace({enabled:false})});
 const b=process.threadCpuUsage();queryCalls++;try{value=host.readPorts.supervisor.list(host.payload);}finally{const c=process.threadCpuUsage(b);readCpuMs=(c.user+c.system)/1000;}
 if(readCpuMs>cfg.budget.readCpuMsMaximum)throw Error('observer_read_cpu_cap');if(value.length!==cfg.expected.sessions)throw Error('observer_session_identity');
 const commands={
  async run(){if(ran)throw Error('observer_no_replacement_or_retry');ran=true;
   const r=await runFr1ObserverControls({value,events:cfg.events,budget:cfg.budget,expected:cfg.expected,admit:()=>performance.now()-started<23000,
    onCell:row=>{const text=JSON.stringify(row),n=Buffer.byteLength(text);if(bytesWritten+n>cfg.budget.totalOutputBytesMaximum-131072)throw Error('observer_output_cap');bytesWritten+=n;fs.writeFileSync(path.join(cfg.output,`cell-${row.family}-${row.slot}.private.json`),text,{flag:'wx',mode:0o600});}});
   // Cell files own full traces; avoid repeating them in the summary.
   const summary={...r,rows:r.rows.map(({meter,...row})=>({...row,meterRows:meter?.stages.length??0,meterClocks:meter?.clocks.length??0}))};
   const text=JSON.stringify(summary);if(bytesWritten+Buffer.byteLength(text)>cfg.budget.totalOutputBytesMaximum)throw Error('observer_summary_output_cap');
   fs.writeFileSync(path.join(cfg.output,'controls.private.json'),text,{flag:'wx',mode:0o600});return summary;
  },shutdown:async()=>{const r=await shutdown();setImmediate(()=>app.exit(0));return r;}
 };
 let buffer='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{buffer+=chunk;if(buffer.length>16384)return app.exit(125);let n;
  while((n=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,n);buffer=buffer.slice(n+1);if(!line)continue;let x;try{x=JSON.parse(line);if(!commands[x.method])throw Error('observer_owned_operation');Promise.resolve(commands[x.method]()).then(result=>send({id:x.id,result}),e=>send({id:x.id,error:{message:e.message}}));}catch(e){send({id:x?.id,error:{message:e.message}});}}
 });process.stdin.once('end',()=>shutdown().finally(()=>app.exit(0)));
 send({event:'ready',pid:process.pid,runtime:{electron:process.versions.electron,node:process.versions.node,v8:process.versions.v8},queryCalls,readCpuMs,inspectorUrl:require('node:inspector').url()??null});
}).catch(async e=>{fs.writeFileSync(path.join(cfg.output,'error.private.txt'),e.stack,{mode:0o600});try{await shutdown();}finally{app.exit(1);}});
