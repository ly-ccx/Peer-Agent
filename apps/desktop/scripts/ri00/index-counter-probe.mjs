/** Index mode changes no methods; isolated session mode restores its owned read wrapper. */
export function createIndexCounterProbe(supervisor,payload,options={}){
  const durationMs=options.durationMs??180000;
  if(!Number.isInteger(durationMs)||durationMs<100||durationMs>180000)throw new Error('bounded_counter_duration_required');
  const store=this,fs=process.getBuiltinModule('fs'),path=process.getBuiltinModule('path'),crypto=process.getBuiltinModule('crypto');
  const {performance,PerformanceObserver}=process.getBuiltinModule('perf_hooks');
  const v8=process.getBuiltinModule('v8');
  const file=path.join(store.getStoreDir(),'evidence-index.jsonl'),gc=[],reads=[],bytes=Buffer.alloc(4*1024*1024,0x5a);
  const stamp=()=>{const s=fs.statSync(file,{bigint:true});return crypto.createHash('sha256').update(JSON.stringify(
    ['dev','ino','size','mtimeNs','ctimeNs'].map(key=>String(s[key])))).digest('hex');};
  const observer=new PerformanceObserver(list=>{for(const e of list.getEntries())gc.push({start:e.startTime,duration:e.duration,kind:e.detail?.kind});});
  observer.observe({entryTypes:['gc']});let stopped=false,active,applicationRoot,backgroundDropped=0,timedOut=false,watchdog;
  const background=[],unattributed=[];
  const original=store.listEvidenceIndex;
  const wrapped=function(...args){
    const sink=active||applicationRoot;
    if(!sink&&!options.observeBackground)return Reflect.apply(original,this,args);
    const start=performance.now(),before=process.threadCpuUsage();
    try{const value=Reflect.apply(original,this,args),after=process.threadCpuUsage();const span={start,end:performance.now(),rows:value.length,
      userMs:(after.user-before.user)/1000,systemMs:(after.system-before.system)/1000};
      if(sink)sink.evidence.push(span);else if(unattributed.length<512)unattributed.push(span);else backgroundDropped++;return value;}
    catch(error){if(sink)sink.readFailure=true;throw error;}
  };
  const originalList=supervisor?.list;
  const wrappedList=function(...args){
    if(active||applicationRoot||stopped)return Reflect.apply(originalList,this,args);
    const row={start:performance.now(),matchesProbeWorkspace:args[0]?.workspaceId===payload?.workspaceId,evidence:[],heapBefore:v8.getHeapStatistics(),spacesBefore:v8.getHeapSpaceStatistics()},before=process.threadCpuUsage(),whole=process.cpuUsage();
    applicationRoot=row;let projection;
    try{projection=Reflect.apply(originalList,this,args);row.rows=projection.length;return projection;}
    catch(error){row.readFailure=true;throw error;}
    finally{const after=process.threadCpuUsage(),processAfter=process.cpuUsage();row.end=performance.now();row.threadUserMs=(after.user-before.user)/1000;row.threadSystemMs=(after.system-before.system)/1000;
      row.processUserMs=(processAfter.user-whole.user)/1000;row.processSystemMs=(processAfter.system-whole.system)/1000;
      // Like the controlled read, hash after the timed region. Hardware brackets
      // retain this observer/serialization tail as outsideMeasuredCpuMs.
      if(projection){try{row.projectionSha256=crypto.createHash('sha256').update(JSON.stringify(projection)).digest('hex');}
        catch{row.metadataFailure=true;}
        const metadataAfter=process.threadCpuUsage();row.metadataCpuMs=(metadataAfter.user+metadataAfter.system-after.user-after.system)/1000;}
      applicationRoot=undefined;if(background.length<128)background.push(row);else backgroundDropped++;}
  };
  if(supervisor)store.listEvidenceIndex=wrapped;
  if(supervisor&&options.observeBackground)supervisor.list=wrappedList;
  const probe={read(kind){
    if(stopped)throw new Error('counter_probe_stopped');
    const beforeStamp=stamp(),heapBefore=v8.getHeapStatistics(),spacesBefore=v8.getHeapSpaceStatistics(),start=performance.now(),thread=process.threadCpuUsage(),whole=process.cpuUsage();let rows=0,projection;
    const details={evidence:[]};active=details;
    try{
    if(kind==='session'){if(!supervisor)throw new Error('session_counter_port_required');projection=supervisor.list({workspaceId:payload.workspaceId});rows=projection.length;}
    else if(kind==='index')rows=store.listEvidenceIndex().length;
    else if(kind==='native')for(let i=0;i<16;i++)rows^=crypto.createHash('sha256').update(bytes).digest().readUInt32LE(0);
    else if(kind!=='noop')throw new Error('invalid_counter_probe_kind');
    }finally{active=undefined;}
    const end=performance.now(),after=process.threadCpuUsage(),processAfter=process.cpuUsage(),afterStamp=stamp();
    const row={kind,start,end,rows,sourceStamp:beforeStamp,sourceStable:beforeStamp===afterStamp,heapBefore,spacesBefore,heapAfter:v8.getHeapStatistics(),spacesAfter:v8.getHeapSpaceStatistics(),
      threadUserMs:(after.user-thread.user)/1000,threadSystemMs:(after.system-thread.system)/1000,
      processUserMs:(processAfter.user-whole.user)/1000,processSystemMs:(processAfter.system-whole.system)/1000,...details};
    if(projection)row.projectionSha256=crypto.createHash('sha256').update(JSON.stringify(projection)).digest('hex');
    reads.push(row);return row;
  },stop(){clearTimeout(watchdog);let restored=true;if(supervisor){if(store.listEvidenceIndex===wrapped)store.listEvidenceIndex=original;else restored=store.listEvidenceIndex===original;}
    if(supervisor&&options.observeBackground){if(supervisor.list===wrappedList)supervisor.list=originalList;else restored=supervisor.list===originalList&&restored;}
    if(!stopped){for(const e of observer.takeRecords())gc.push({start:e.startTime,duration:e.duration,kind:e.detail?.kind});observer.disconnect();stopped=true;}
    for(const read of [...reads,...background,...unattributed])read.gcMs=gc.reduce((sum,e)=>sum+Math.max(0,Math.min(read.end,e.start+e.duration)-Math.max(read.start,e.start)),0);
    for(const read of [...reads,...background])for(const span of read.evidence)span.gcMs=gc.reduce((sum,e)=>sum+Math.max(0,Math.min(span.end,e.start+e.duration)-Math.max(span.start,e.start)),0);
    return {stopped,restored,reads,gc,background,unattributed,backgroundDropped,timedOut};}};
  watchdog=setTimeout(()=>{timedOut=true;probe.stop();if(options.closeInspectorOnWatchdog===true)process.getBuiltinModule('inspector').close();},durationMs);watchdog.unref?.();
  return probe;
}
