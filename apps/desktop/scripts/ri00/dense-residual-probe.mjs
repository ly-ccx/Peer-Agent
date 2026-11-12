/** Serialized into both hosts once. Passive records and controlled reads share the same reader. */
export function createDenseResidualProbe(supervisor,payload,options={}){
  const durationMs=options.durationMs??1200000;
  if(!Number.isInteger(durationMs)||durationMs<100||durationMs>1200000)throw Error('bounded_dense_duration_required');
  const store=this,fs=process.getBuiltinModule('fs'),path=process.getBuiltinModule('path'),crypto=process.getBuiltinModule('crypto');
  const {performance,PerformanceObserver}=process.getBuiltinModule('perf_hooks'),v8=process.getBuiltinModule('v8');
  const originalIndex=store.listEvidenceIndex,originalList=supervisor.list;
  if(typeof originalIndex!=='function'||typeof originalList!=='function')throw Error('dense_read_ports_required');
  const file=path.join(store.getStoreDir(),'evidence-index.jsonl'),rows=[],gc=[],bytes=Buffer.alloc(4*1024*1024,0x5a);
  let current,stopped=false,timedOut=false,cursor=0,gcCursor=0,timer,restored=null,bare=false,lastOutsideEnd=-Infinity,pendingTake=null;
  const state={metadataErrors:0,dropped:0,gcDropped:0,controlledCpuMs:0,naturalRows:0,controlledRows:0,outsideRows:0};
  const stamp=()=>{const s=fs.statSync(file,{bigint:true});return crypto.createHash('sha256').update(JSON.stringify(
    ['dev','ino','size','mtimeNs','ctimeNs'].map(k=>String(s[k])))).digest('hex');};
  const heap=()=>({used:v8.getHeapStatistics().used_heap_size,spaces:v8.getHeapSpaceStatistics().filter(s=>['new_space','old_space'].includes(s.space_name))});
  const cpu=before=>{const after=process.threadCpuUsage(),whole=process.cpuUsage();return {after,userMs:(after.user-before.thread.user)/1000,
    systemMs:(after.system-before.thread.system)/1000,processUserMs:(whole.user-before.whole.user)/1000,processSystemMs:(whole.system-before.whole.system)/1000};};
  function stack(){const d=Object.getOwnPropertyDescriptor(Error,'stackTraceLimit');
    try{Object.defineProperty(Error,'stackTraceLimit',{configurable:true,writable:true,enumerable:d?.enumerable??false,value:48});return String(new Error('ri00-dense-entry').stack).slice(0,16384);}
    catch{state.metadataErrors++;return null;}finally{try{if(d)Object.defineProperty(Error,'stackTraceLimit',d);else delete Error.stackTraceLimit;}catch{state.metadataErrors++;}}
  }
  function keep(row){const key=row.origin==='controlled'?'controlledRows':row.origin==='outside-index'?'outsideRows':'naturalRows',limit=key==='outsideRows'?2048:256;
    if(state[key]<limit){rows.push(row);state[key]++;}else{state.dropped++;probe.stop('row-cap');}}
  const observer=new PerformanceObserver(list=>{for(const e of list.getEntries()){
    if(gc.length>=16384){state.gcDropped++;probe.stop('gc-cap');break;}
    gc.push({start:e.startTime,duration:e.duration,kind:e.detail?.kind});
  }});
  function root(origin,receiver,args,label,fn=originalList){
    if(stopped)return Reflect.apply(fn,receiver,args);
    let row;const metadataBefore=process.threadCpuUsage();
    try{row={origin,label,observationMode:bare?'bare':'detailed',matches:origin!=='outside-index'&&args[0]?.workspaceId===payload.workspaceId,
      entryStack:origin!=='outside-index'||performance.now()-lastOutsideEnd>250?stack():null,sourceBefore:stamp(),heapBefore:heap(),evidence:[]};}
    catch{state.metadataErrors++;return Reflect.apply(fn,receiver,args);}
    const start=performance.now(),before={thread:process.threadCpuUsage(),whole:process.cpuUsage()},previous=current;row.start=start;current=row;
    let value;
    try{value=Reflect.apply(fn,receiver,args);row.rows=value.length;return value;}
    catch(error){row.readFailure=true;throw error;}
    finally{row.end=performance.now();const measured=cpu(before);current=previous;
      Object.assign(row,{userMs:measured.userMs,systemMs:measured.systemMs,processUserMs:measured.processUserMs,processSystemMs:measured.processSystemMs});
      if(origin==='controlled')state.controlledCpuMs+=row.userMs+row.systemMs;
      if(origin==='outside-index'){lastOutsideEnd=row.end;row.evidence.push({start:row.start,end:row.end,rows:row.rows??null,userMs:row.userMs,systemMs:row.systemMs});}
      try{row.heapAfter=heap();row.sourceAfter=stamp();if(value&&origin!=='outside-index')row.outputSha256=crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');}
      catch{state.metadataErrors++;row.metadataFailure=true;}
      const after=process.threadCpuUsage();row.metadataCpuMs=(after.user+after.system-metadataBefore.user-metadataBefore.system)/1000-row.userMs-row.systemMs;
      keep(row);
    }
  }
  const index=function(...args){
    if(!current&&!stopped)return root('outside-index',this,args,null,originalIndex);
    const before=process.threadCpuUsage(),start=performance.now();let value;
    try{value=Reflect.apply(originalIndex,this,args);return value;}
    finally{if(current){const after=process.threadCpuUsage();current.evidence.push({start,end:performance.now(),rows:Array.isArray(value)?value.length:null,
      userMs:(after.user-before.user)/1000,systemMs:(after.system-before.system)/1000});}}
  };
  const list=function(...args){return root('natural',this,args,null);};
  function annotate(row){let minor=0,major=0,incremental=0,overlap=0;
    for(const e of gc){const n=Math.max(0,Math.min(row.end,e.start+e.duration)-Math.max(row.start,e.start));if(!n)continue;overlap+=n;
      if(e.kind===1)minor++;if(e.kind===4)major++;if(e.kind===8)incremental++;}
    return {...row,gc:{minor,major,incremental,observedOverlapMs:overlap,absenceNotProven:true}};
  }
  const probe={read(label){if(stopped)throw Error('dense_probe_stopped');root('controlled',supervisor,[{workspaceId:payload.workspaceId}],label);return rows.at(-1);},
    setDetail(mode){if(stopped||!['bare','detailed'].includes(mode))throw Error('invalid_dense_observation_mode');const a=bare?originalIndex:index,b=bare?originalList:list;
      if(store.listEvidenceIndex!==a||supervisor.list!==b)throw Error('dense_method_owner_changed');
      bare=mode==='bare';store.listEvidenceIndex=bare?originalIndex:index;supervisor.list=bare?originalList:list;return {mode};},
    native(){if(stopped)throw Error('dense_probe_stopped');const before=process.threadCpuUsage(),start=performance.now();let value=0;
      for(let i=0;i<16;i++)value^=crypto.createHash('sha256').update(bytes).digest().readUInt32LE(0);
      const after=process.threadCpuUsage();return {start,end:performance.now(),userMs:(after.user-before.user)/1000,systemMs:(after.system-before.system)/1000,value};},
    take(){if(pendingTake)throw Error('dense_take_ack_required');pendingTake=(async()=>{await new Promise(r=>setImmediate(()=>setImmediate(r)));const fresh=rows.slice(cursor).map(annotate),events=gc.slice(gcCursor);cursor=rows.length;gcCursor=gc.length;
      return {rows:fresh,gc:events,state:{...state,stopped,timedOut,restored},heap:heap(),clock:{hrtimeMs:Number(process.hrtime.bigint())/1e6,performanceMs:performance.now()}};})();return pendingTake;},
    ack(){pendingTake=null;return true;},
    stop(reason='controller'){clearTimeout(timer);pendingTake=null;if(!stopped){stopped=true;
      for(const e of observer.takeRecords()){if(gc.length<16384)gc.push({start:e.startTime,duration:e.duration,kind:e.detail?.kind});else state.gcDropped++;}observer.disconnect();
      const a=store.listEvidenceIndex===index,b=supervisor.list===list;if(a)store.listEvidenceIndex=originalIndex;if(b)supervisor.list=originalList;
      restored=(a||store.listEvidenceIndex===originalIndex)&&(b||supervisor.list===originalList);state.stopReason=reason;}
      return {...state,stopped,timedOut,restored};}};
  try{observer.observe({entryTypes:['gc']});store.listEvidenceIndex=index;supervisor.list=list;}
  catch(error){if(store.listEvidenceIndex===index)store.listEvidenceIndex=originalIndex;if(supervisor.list===list)supervisor.list=originalList;observer.disconnect();throw error;}
  timer=setTimeout(()=>{timedOut=true;probe.stop('watchdog');if(options.closeInspectorOnWatchdog)process.getBuiltinModule('inspector').close();},durationMs);timer.unref?.();return probe;
}
