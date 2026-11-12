/** Index mode changes no methods; isolated session mode restores its owned read wrapper. */
export function createIndexCounterProbe(supervisor,payload){
  const store=this,fs=process.getBuiltinModule('fs'),path=process.getBuiltinModule('path'),crypto=process.getBuiltinModule('crypto');
  const {performance,PerformanceObserver}=process.getBuiltinModule('perf_hooks');
  const file=path.join(store.getStoreDir(),'evidence-index.jsonl'),gc=[],reads=[],bytes=Buffer.alloc(4*1024*1024,0x5a);
  const stamp=()=>{const s=fs.statSync(file,{bigint:true});return crypto.createHash('sha256').update(JSON.stringify(
    ['dev','ino','size','mtimeNs','ctimeNs'].map(key=>String(s[key])))).digest('hex');};
  const observer=new PerformanceObserver(list=>{for(const e of list.getEntries())gc.push({start:e.startTime,duration:e.duration,kind:e.detail?.kind});});
  observer.observe({entryTypes:['gc']});let stopped=false,active;
  const original=store.listEvidenceIndex;
  const wrapped=function(...args){
    if(!active)return Reflect.apply(original,this,args);
    const start=performance.now(),before=process.threadCpuUsage();
    try{const value=Reflect.apply(original,this,args),after=process.threadCpuUsage();active.evidence.push({start,end:performance.now(),rows:value.length,
      userMs:(after.user-before.user)/1000,systemMs:(after.system-before.system)/1000});return value;}
    catch(error){active.readFailure=true;throw error;}
  };
  if(supervisor)store.listEvidenceIndex=wrapped;
  return {read(kind){
    if(stopped)throw new Error('counter_probe_stopped');
    const beforeStamp=stamp(),start=performance.now(),thread=process.threadCpuUsage(),whole=process.cpuUsage();let rows=0,projection;
    const details={evidence:[]};active=details;
    try{
    if(kind==='session'){if(!supervisor)throw new Error('session_counter_port_required');projection=supervisor.list({workspaceId:payload.workspaceId});rows=projection.length;}
    else if(kind==='index')rows=store.listEvidenceIndex().length;
    else if(kind==='native')for(let i=0;i<16;i++)rows^=crypto.createHash('sha256').update(bytes).digest().readUInt32LE(0);
    else if(kind!=='noop')throw new Error('invalid_counter_probe_kind');
    }finally{active=undefined;}
    const end=performance.now(),after=process.threadCpuUsage(),processAfter=process.cpuUsage(),afterStamp=stamp();
    const row={kind,start,end,rows,sourceStamp:beforeStamp,sourceStable:beforeStamp===afterStamp,
      threadUserMs:(after.user-thread.user)/1000,threadSystemMs:(after.system-thread.system)/1000,
      processUserMs:(processAfter.user-whole.user)/1000,processSystemMs:(processAfter.system-whole.system)/1000,...details};
    if(projection)row.projectionSha256=crypto.createHash('sha256').update(JSON.stringify(projection)).digest('hex');
    reads.push(row);return row;
  },stop(){let restored=true;if(supervisor){if(store.listEvidenceIndex===wrapped)store.listEvidenceIndex=original;else restored=store.listEvidenceIndex===original;}
    if(!stopped){for(const e of observer.takeRecords())gc.push({start:e.startTime,duration:e.duration,kind:e.detail?.kind});observer.disconnect();stopped=true;}
    for(const read of reads)read.gcMs=gc.reduce((sum,e)=>sum+Math.max(0,Math.min(read.end,e.start+e.duration)-Math.max(read.start,e.start)),0);
    for(const read of reads)for(const span of read.evidence)span.gcMs=gc.reduce((sum,e)=>sum+Math.max(0,Math.min(span.end,e.start+e.duration)-Math.max(span.start,e.start)),0);
    return {stopped,restored,reads,gc};}};
}
