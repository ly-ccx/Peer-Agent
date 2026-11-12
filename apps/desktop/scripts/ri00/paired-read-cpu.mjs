/** Serialized identically into both hosts. Read-only, bounded, and restores only owned methods. */
export async function controlledSessionRead(goalPlanStore, payload) {
  const fs=process.getBuiltinModule('fs'),path=process.getBuiltinModule('path'),crypto=process.getBuiltinModule('crypto');
  const {performance,PerformanceObserver}=process.getBuiltinModule('perf_hooks');
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const cpu=before=>{const after=process.threadCpuUsage();return {userMs:(after.user-before.user)/1000,systemMs:(after.system-before.system)/1000};};
  const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
  const file=path.join(goalPlanStore.getStoreDir(),'evidence-index.jsonl');
  const identity=()=>{const s=fs.statSync(file,{bigint:true});return {sha256:digest(fs.readFileSync(file)),stampSha256:digest(JSON.stringify(
    ['dev','ino','size','mtimeNs','ctimeNs'].map(key=>String(s[key])))),bytes:String(s.size)};};
  const result={kind:'controlled-session-read-not-natural-input',startedAt:new Date().toISOString(),sourceBefore:identity(),reads:[],gc:[],restored:[],failures:[]};
  const observer=new PerformanceObserver(list=>{for(const e of list.getEntries())result.gc.push({start:e.startTime,duration:e.duration,kind:e.detail?.kind});});
  observer.observe({entryTypes:['gc']});
  const restores=[];let active;
  for(const key of ['getPlan','listEvidenceIndex']){
    const original=goalPlanStore[key];if(typeof original!=='function')throw new Error('required_read_method_missing');
    const wrapped=function(...args){
      if(!active)return Reflect.apply(original,this,args);
      if(key==='getPlan'){active.getPlanCalls++;return Reflect.apply(original,this,args);}
      const start=performance.now(),before=process.threadCpuUsage();
      try{const value=Reflect.apply(original,this,args);active.evidence.push({start,end:performance.now(),...cpu(before),rows:value.length});return value;}
      catch(error){active.readFailure=true;throw error;}
    };
    goalPlanStore[key]=wrapped;
    restores.push(()=>{if(goalPlanStore[key]!==wrapped)return false;goalPlanStore[key]=original;return true;});
  }
  const bytes=Buffer.alloc(4*1024*1024,0x5a);
  try{
    for(let round=0;round<3;round++){
      const controlStart=performance.now(),controlCpu=process.threadCpuUsage();let control=0;
      for(let i=0;i<4;i++)control^=crypto.createHash('sha256').update(bytes).digest().readUInt32LE(0);
      const calibration={start:controlStart,end:performance.now(),...cpu(controlCpu),value:control};
      const row={round,calibration,evidence:[],getPlanCalls:0,start:performance.now()},before=process.threadCpuUsage();active=row;
      let sessions;
      try{sessions=this.list({workspaceId:payload.workspaceId});}
      finally{row.end=performance.now();Object.assign(row,cpu(before));active=undefined;}
      row.sessions=sessions.length;row.projectionSha256=digest(JSON.stringify(sessions));result.reads.push(row);
      await wait(250);
    }
    result.ok=result.reads.every(row=>row.sessions>0&&row.getPlanCalls>0&&row.evidence.length>0&&!row.readFailure);
  }catch(error){result.ok=false;result.failures.push({name:error.name,code:error.code||null});}
  finally{
    for(const restore of restores.reverse())result.restored.push(restore());
    active=undefined;await wait(20);for(const e of observer.takeRecords())result.gc.push({start:e.startTime,duration:e.duration,kind:e.detail?.kind});observer.disconnect();
    result.sourceAfter=identity();result.sourceUnchanged=JSON.stringify(result.sourceBefore)===JSON.stringify(result.sourceAfter);
    const overlap=(start,end)=>result.gc.reduce((sum,e)=>sum+Math.max(0,Math.min(end,e.start+e.duration)-Math.max(start,e.start)),0);
    for(const row of result.reads){row.gcMs=overlap(row.start,row.end);row.calibration.gcMs=overlap(row.calibration.start,row.calibration.end);
      for(const read of row.evidence)read.gcMs=overlap(read.start,read.end);}
    result.ok=result.ok&&result.sourceUnchanged&&result.restored.every(Boolean);
    result.finishedAt=new Date().toISOString();
  }
  return result;
}
