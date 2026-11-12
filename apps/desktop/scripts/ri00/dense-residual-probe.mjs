/** Serialized into both hosts once. Passive records and controlled reads share the same reader. */
export function createDenseResidualProbe(supervisor,payload,options={}){
  const durationMs=options.durationMs??1200000,long=options.longWatch===true;
  if(!Number.isInteger(durationMs)||durationMs<100||durationMs>(long?14400000:1200000))throw Error('bounded_dense_duration_required');
  const leaseMs=options.leaseMs??90000;
  if(long&&(!Number.isInteger(leaseMs)||leaseMs<100||leaseMs>90000))throw Error('bounded_dense_lease_required');
  const store=this,fs=process.getBuiltinModule('fs'),path=process.getBuiltinModule('path'),crypto=process.getBuiltinModule('crypto');
  const {performance,PerformanceObserver}=process.getBuiltinModule('perf_hooks'),v8=process.getBuiltinModule('v8');
  const originalIndex=store.listEvidenceIndex,originalList=supervisor.list;
  if(typeof originalIndex!=='function'||typeof originalList!=='function')throw Error('dense_read_ports_required');
  const file=path.join(store.getStoreDir(),'evidence-index.jsonl'),rows=[],gc=[],bytes=Buffer.alloc(4*1024*1024,0x5a);
  const binding=options.notificationName,notification=binding?globalThis[binding]:null;
  if(binding&&typeof notification!=='function')throw Error('dense_notification_binding_required');
  let current,stopped=false,timedOut=false,cursor=0,gcCursor=0,timer,leaseTimer,notice,restored=null,bare=false,lastOutsideEnd=-Infinity,pendingTake=null;
  const rowBytes=[],state={metadataErrors:0,dropped:0,gcDropped:0,controlledCpuMs:0,nativeCpuMs:0,probeCpuMs:0,retainedRowBytes:0,naturalRows:0,controlledRows:0,outsideRows:0};
  const threadTotal=()=>{const c=process.threadCpuUsage();return(c.user+c.system)/1000;};
  const newSpace=()=>v8.getHeapSpaceStatistics().find(s=>s.space_name==='new_space').space_size;
  function expired(reason){timedOut=reason==='watchdog'||reason==='controller-lease';probe.stop(reason);}
  function limits(){if(!long||stopped)return;
    if(state.controlledCpuMs>=60000||state.nativeCpuMs>=3000||state.probeCpuMs>=5000)expired('cpu-budget');
    else if(state.retainedRowBytes+gc.length*96>16777216)expired('metadata-byte-budget');
  }
  function notify(){if(!notification||notice||stopped)return;notice=setImmediate(()=>{notice=null;const before=threadTotal();
    try{if(globalThis[binding]!==notification)throw Error('dense_notification_owner_changed');notification('rows');}
    catch{state.metadataErrors++;probe.stop('notification-failure');}
    finally{state.probeCpuMs+=threadTotal()-before;limits();}
  });}
  const stamp=()=>{const s=fs.statSync(file,{bigint:true});return crypto.createHash('sha256').update(JSON.stringify(
    ['dev','ino','size','mtimeNs','ctimeNs'].map(k=>String(s[k])))).digest('hex');};
  const heap=()=>{const h=v8.getHeapStatistics(),spaces=v8.getHeapSpaceStatistics();return {used:h.used_heap_size,spaces:long?spaces:spaces.filter(s=>['new_space','old_space'].includes(s.space_name)),
    ...(long?{heapLimit:h.heap_size_limit,external:h.external_memory,malloced:h.malloced_memory,nativeContexts:h.number_of_native_contexts,detachedContexts:h.number_of_detached_contexts}:{})};};
  const cpu=before=>{const after=process.threadCpuUsage(),whole=process.cpuUsage();return {after,userMs:(after.user-before.thread.user)/1000,
    systemMs:(after.system-before.thread.system)/1000,processUserMs:(whole.user-before.whole.user)/1000,processSystemMs:(whole.system-before.whole.system)/1000};};
  function stack(){const d=Object.getOwnPropertyDescriptor(Error,'stackTraceLimit');
    try{Object.defineProperty(Error,'stackTraceLimit',{configurable:true,writable:true,enumerable:d?.enumerable??false,value:48});return String(new Error('ri00-dense-entry').stack).slice(0,16384);}
    catch{state.metadataErrors++;return null;}finally{try{if(d)Object.defineProperty(Error,'stackTraceLimit',d);else delete Error.stackTraceLimit;}catch{state.metadataErrors++;}}
  }
  function keep(row){const key=row.origin==='controlled'?'controlledRows':row.origin==='outside-index'?'outsideRows':'naturalRows',limit=key==='outsideRows'?2048:256;
    if((long?rows.filter(r=>r.origin===row.origin).length:state[key])<limit){const before=threadTotal();rows.push(row);state[key]++;
      if(long){const n=Buffer.byteLength(JSON.stringify(row));rowBytes.push(n);state.retainedRowBytes+=n;state.probeCpuMs+=threadTotal()-before;}notify();limits();
    }else{state.dropped++;probe.stop('row-cap');}}
  const observer=new PerformanceObserver(list=>{const before=threadTotal();for(const e of list.getEntries()){
    if(gc.length>=(long?32768:16384)){state.gcDropped++;probe.stop('gc-cap');break;}
    gc.push({start:e.startTime,duration:e.duration,kind:e.detail?.kind});
  }if(long){state.probeCpuMs+=threadTotal()-before;limits();}});
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
      if(long)row.instrumentationCpuMs=row.metadataCpuMs+row.evidence.reduce((s,e)=>s+(e.metadataCpuMs||0),0);
      if(long)state.probeCpuMs+=row.metadataCpuMs;
      keep(row);
    }
  }
  const index=function(...args){
    if(!current&&!stopped)return root('outside-index',this,args,null,originalIndex);
    const observeIndex=long&&current?.origin==='natural';
    const metadataBefore=long?threadTotal():0,entryStack=long&&current?.evidence.length===0?stack():null,spaceBefore=observeIndex?newSpace():null,wholeBefore=observeIndex?process.cpuUsage():null;
    const before=process.threadCpuUsage(),start=performance.now();let value;
    try{value=Reflect.apply(originalIndex,this,args);return value;}
    finally{if(current){const after=process.threadCpuUsage(),end=performance.now(),userMs=(after.user-before.user)/1000,systemMs=(after.system-before.system)/1000;
      const span={start,end,rows:Array.isArray(value)?value.length:null,userMs,systemMs};
      if(entryStack)span.entryStack=entryStack;
      if(observeIndex){const whole=process.cpuUsage();Object.assign(span,{newSpaceBefore:spaceBefore,newSpaceAfter:newSpace(),processUserMs:(whole.user-wholeBefore.user)/1000,processSystemMs:(whole.system-wholeBefore.system)/1000});}
      if(long){span.metadataCpuMs=threadTotal()-metadataBefore-userMs-systemMs;state.probeCpuMs+=span.metadataCpuMs;}
      current.evidence.push(span);}}
  };
  const list=function(...args){return root('natural',this,args,null);};
  function overlapGc(row){let minor=0,major=0,incremental=0,overlap=0;
    for(const e of gc){const n=Math.max(0,Math.min(row.end,e.start+e.duration)-Math.max(row.start,e.start));if(!n)continue;overlap+=n;
      if(e.kind===1)minor++;if(e.kind===4)major++;if(e.kind===8)incremental++;}
    return {minor,major,incremental,observedOverlapMs:overlap,absenceNotProven:true};
  }
  const annotate=row=>({...row,gc:overlapGc(row),...(long?{evidence:row.evidence.map(e=>({...e,gc:overlapGc(e)}))}:{})});
  const probe={read(label){if(stopped)throw Error('dense_probe_stopped');limits();if(stopped)throw Error('dense_probe_budget_exhausted');root('controlled',supervisor,[{workspaceId:payload.workspaceId}],label);return rows.at(-1);},
    vm(){if(stopped)throw Error('dense_probe_stopped');return {heap:v8.getHeapStatistics(),spaces:v8.getHeapSpaceStatistics(),code:v8.getHeapCodeStatistics(),versions:{v8:process.versions.v8,cachedDataVersionTag:v8.cachedDataVersionTag()}};},
    renew(){if(stopped)throw Error('dense_probe_stopped');const a=bare?originalIndex:index,b=bare?originalList:list;
      if(store.listEvidenceIndex!==a||supervisor.list!==b){probe.stop('method-owner-changed');throw Error('dense_method_owner_changed');}
      clearTimeout(leaseTimer);if(long){leaseTimer=setTimeout(()=>expired('controller-lease'),leaseMs);leaseTimer.unref?.();}return {...state,stopped};},
    setDetail(mode){if(stopped||!['bare','detailed'].includes(mode))throw Error('invalid_dense_observation_mode');const a=bare?originalIndex:index,b=bare?originalList:list;
      if(store.listEvidenceIndex!==a||supervisor.list!==b)throw Error('dense_method_owner_changed');
      bare=mode==='bare';store.listEvidenceIndex=bare?originalIndex:index;supervisor.list=bare?originalList:list;return {mode};},
    native(){if(stopped)throw Error('dense_probe_stopped');const before=process.threadCpuUsage(),start=performance.now();let value=0;
      for(let i=0;i<16;i++)value^=crypto.createHash('sha256').update(bytes).digest().readUInt32LE(0);
      const after=process.threadCpuUsage(),userMs=(after.user-before.user)/1000,systemMs=(after.system-before.system)/1000;
      state.nativeCpuMs+=userMs+systemMs;limits();return {start,end:performance.now(),userMs,systemMs,value};},
    take(){if(pendingTake){if(long)return pendingTake;throw Error('dense_take_ack_required');}pendingTake=(async()=>{await new Promise(r=>setImmediate(()=>setImmediate(r)));const before=threadTotal(),fresh=rows.slice(cursor).map(annotate),events=gc.slice(gcCursor);cursor=rows.length;gcCursor=gc.length;
      const result={rows:fresh,gc:events,heap:heap(),clock:{hrtimeMs:Number(process.hrtime.bigint())/1e6,performanceMs:performance.now()}};
      if(long){state.probeCpuMs+=threadTotal()-before;limits();}return {...result,state:{...state,stopped,timedOut,restored}};})();return pendingTake;},
    ack(){const before=threadTotal();pendingTake=null;if(long){rows.splice(0,cursor);state.retainedRowBytes-=rowBytes.splice(0,cursor).reduce((s,x)=>s+x,0);cursor=0;
      const cutoff=Math.min(performance.now()-120000,...rows.map(r=>r.start));let n=0;while(n<gcCursor&&gc[n].start+gc[n].duration<cutoff)n++;gc.splice(0,n);gcCursor-=n;
      state.probeCpuMs+=threadTotal()-before;limits();}return true;},
    stop(reason='controller'){clearTimeout(timer);clearTimeout(leaseTimer);clearImmediate(notice);pendingTake=null;if(!stopped){stopped=true;
      for(const e of observer.takeRecords()){if(gc.length<(long?32768:16384))gc.push({start:e.startTime,duration:e.duration,kind:e.detail?.kind});else state.gcDropped++;}observer.disconnect();
      const a=store.listEvidenceIndex===index,b=supervisor.list===list;if(a)store.listEvidenceIndex=originalIndex;if(b)supervisor.list=originalList;
      restored=(a||store.listEvidenceIndex===originalIndex)&&(b||supervisor.list===originalList);state.stopReason=reason;
      if(reason!=='controller'&&notification)try{notification('stopped');}catch{}
      if(binding){state.bindingRestored=globalThis[binding]===notification;if(state.bindingRestored)delete globalThis[binding];}}
      if(reason!=='controller'&&options.closeInspectorOnWatchdog)setTimeout(()=>process.getBuiltinModule('inspector').close(),5000).unref?.();
      return {...state,stopped,timedOut,restored};}};
  try{observer.observe({entryTypes:['gc']});store.listEvidenceIndex=index;supervisor.list=list;}
  catch(error){if(store.listEvidenceIndex===index)store.listEvidenceIndex=originalIndex;if(supervisor.list===list)supervisor.list=originalList;observer.disconnect();throw error;}
  timer=setTimeout(()=>expired('watchdog'),durationMs);timer.unref?.();probe.renew();return probe;
}
