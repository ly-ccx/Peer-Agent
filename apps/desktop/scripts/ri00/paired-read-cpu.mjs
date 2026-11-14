/** Serialized identically into both hosts. Read-only, bounded, and restores only owned methods. */
export async function controlledSessionRead(goalPlanStore, payload, options={}) {
  const rounds=options.rounds??3,delayMs=options.delayMs??250;
  if(!Number.isInteger(rounds)||rounds<3||rounds>9||!Number.isInteger(delayMs)||delayMs<100||delayMs>1000)throw new Error('unbounded_session_probe');
  for(const key of ['getPlan','listEvidenceIndex'])if(typeof goalPlanStore[key]!=='function')throw new Error('required_read_method_missing');
  const fs=process.getBuiltinModule('fs'),path=process.getBuiltinModule('path'),crypto=process.getBuiltinModule('crypto');
  const {performance,PerformanceObserver}=process.getBuiltinModule('perf_hooks');
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const cpu=before=>{const after=process.threadCpuUsage();return {userMs:(after.user-before.user)/1000,systemMs:(after.system-before.system)/1000};};
  const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
  const file=path.join(goalPlanStore.getStoreDir(),'evidence-index.jsonl');
  const identity=()=>{const s=fs.statSync(file,{bigint:true});return {stampSha256:digest(JSON.stringify(
    ['dev','ino','size','mtimeNs','ctimeNs'].map(key=>String(s[key])))),bytes:String(s.size)};};
  const result={kind:'controlled-session-read-not-natural-input',startedAt:new Date().toISOString(),sourceBefore:identity(),
    clockCalibration:{hrtimeMs:Number(process.hrtime.bigint())/1e6,performanceMs:performance.now()},reads:[],gc:[],restored:[],failures:[]};
  const observer=new PerformanceObserver(list=>{for(const e of list.getEntries())result.gc.push({start:e.startTime,duration:e.duration,kind:e.detail?.kind});});
  observer.observe({entryTypes:['gc']});
  const restores=[];let active;
  for(const key of ['getPlan','listEvidenceIndex']){
    const original=goalPlanStore[key];
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
  function integerControlKernel(iterations){let a=0x12345678,b=0x76543210;for(let i=0;i<iterations;i++){a=(Math.imul(a^(a>>>13),0x5bd1e995)+i)|0;b=Math.imul(b^(a>>>15),0x1b873593);}return (a^b)|0;}
  const integerControl=()=>{const start=performance.now(),before=process.threadCpuUsage(),value=integerControlKernel(2000000);return {start,end:performance.now(),...cpu(before),value};};
  try{
    if(options.jsControl){result.jsControlWarm=[];for(let i=0;i<30;i++){result.jsControlWarm.push(integerControl());await wait(0);}}
    for(let round=0;round<rounds;round++){
      const v8=process.getBuiltinModule('v8');
      const row={round,calibrationOrder:'after-timed-read',evidence:[],getPlanCalls:0,heapBefore:v8.getHeapStatistics(),spacesBefore:v8.getHeapSpaceStatistics(),start:performance.now()},before=process.threadCpuUsage();active=row;
      let sessions;
      try{sessions=this.list({workspaceId:payload.workspaceId});}
      finally{row.end=performance.now();Object.assign(row,cpu(before));active=undefined;row.heapAfter=v8.getHeapStatistics();row.spacesAfter=v8.getHeapSpaceStatistics();}
      const controlStart=performance.now(),controlCpu=process.threadCpuUsage();let control=0;
      for(let i=0;i<4;i++)control^=crypto.createHash('sha256').update(bytes).digest().readUInt32LE(0);
      row.calibration={start:controlStart,end:performance.now(),...cpu(controlCpu),value:control};
      if(options.jsControl)row.jsCalibration=integerControl();
      row.sessions=sessions.length;row.projectionSha256=digest(JSON.stringify(sessions));result.reads.push(row);
      await wait(delayMs);
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
