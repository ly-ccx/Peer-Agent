/** Compare existing and freshly parsed equal records without replacing the production cache. */
export async function controlledCacheRead(normalizeRecord,retain,readJsonl,reader,storeDir,dependencies){
  const fs=process.getBuiltinModule('fs'),path=process.getBuiltinModule('path'),crypto=process.getBuiltinModule('crypto'),v8=process.getBuiltinModule('v8');
  const {performance,PerformanceObserver}=process.getBuiltinModule('perf_hooks'),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
  const file=path.join(storeDir,'evidence-index.jsonl');
  const identity=()=>{const s=fs.statSync(file,{bigint:true});return {sha256:hash(fs.readFileSync(file)),stampSha256:hash(JSON.stringify(
    ['dev','ino','size','mtimeNs','ctimeNs'].map(key=>String(s[key])))),bytes:String(s.size)};};
  const digest=async rows=>{const h=crypto.createHash('sha256');for(let i=0;i<rows.length;i++){h.update(JSON.stringify(rows[i])+'\n');if(i%2048===2047)await wait(0);}return h.digest('hex');};
  const cpu=before=>{const after=process.threadCpuUsage();return {userMs:(after.user-before.user)/1000,systemMs:(after.system-before.system)/1000};};
  const old=this.records,cacheVersion=this.version,fresh=readJsonl(file);
  const result={kind:'controlled-existing-vs-fresh-cache-not-natural-input',startedAt:new Date().toISOString(),sourceBefore:identity(),rows:old.length,freshRows:fresh.length,
    functionSha256:Object.fromEntries(Object.entries({normalizeRecord,retain,readJsonl,reader}).map(([k,v])=>[k,hash(v.toString())])),reads:[],primitiveReads:[],gc:[],failures:[],heapBefore:v8.getHeapStatistics()};
  const observer=new PerformanceObserver(list=>{for(const e of list.getEntries())result.gc.push({start:e.startTime,duration:e.duration,kind:e.detail?.kind});});observer.observe({entryTypes:['gc']});
  try{
    result.oldDigest=await digest(old);result.freshDigest=await digest(fresh);
    if(result.oldDigest!==result.freshDigest)throw new Error('cache_raw_records_differ');
    const cases={reader:()=>reader(),existing:()=>retain(old.map(normalizeRecord).filter(Boolean)),fresh:()=>retain(fresh.map(normalizeRecord).filter(Boolean))};
    result.outputs={};for(const [name,fn]of Object.entries(cases)){result.outputs[name]=await digest(fn());await wait(50);}
    if(new Set(Object.values(result.outputs)).size!==1)throw new Error('cache_normalized_outputs_differ');
    const normalizers={production:normalizeRecord};
    if(dependencies){
      const names=['normalizeOptionalString','normalizeInteractiveInspectionReceipt','interactiveInspectionEvidenceRef','normalizeEvidenceRefList','normalizeInteractiveUserArtifact'];
      if(dependencies.length!==6||dependencies.some(fn=>typeof fn!=='function'))throw new Error('normalizer_dependencies_invalid');
      const make=values=>Function(...names,`"use strict";return (${normalizeRecord.toString()});`)(...values);
      normalizers['fresh-normalizer']=make(dependencies.slice(0,5));
      const helpers=dependencies.slice(0,5);
      helpers[0]=Function(`"use strict";return (${helpers[0].toString()});`)();
      const stringArray=Function(`"use strict";return (${dependencies[5].toString()});`)();
      helpers[3]=Function('normalizeStringArray',`"use strict";return (${helpers[3].toString()});`)(stringArray);
      normalizers['fresh-helpers']=make(helpers);
      result.cloneOutputs={};result.normalizerSha256={};
      for(const [name,fn]of Object.entries(normalizers)){
        result.normalizerSha256[name]=hash(fn.toString());result.cloneOutputs[name]=await digest(retain(old.map(fn).filter(Boolean)));
      }
      if(new Set(Object.values(result.cloneOutputs)).size!==1||result.cloneOutputs.production!==result.outputs.reader)throw new Error('cloned_normalizer_outputs_differ');
    }
    // All six permutations balance every case in every position; retain individual GC overlaps.
    const orders=[['reader','existing','fresh'],['fresh','existing','reader'],['existing','reader','fresh'],['fresh','reader','existing'],['reader','fresh','existing'],['existing','fresh','reader']];
    for(let group=0;group<orders.length;group++){
      for(const name of orders[group]){
        const start=performance.now(),before=process.threadCpuUsage(),output=cases[name]();
        result.reads.push({name,group,start,end:performance.now(),...cpu(before),rows:output.length});
      }
      await wait(100);
    }
    // Small alternating equal-input chunks isolate the production record normalizer from
    // whole-array retention and recurring GC phase. This is a separate primitive metric,
    // never substituted for the measured full-index latency or cross-chunk fold semantics.
    const chunks={existing:[],fresh:[]},size=4096;
    for(let offset=0;offset<old.length;offset+=size){chunks.existing.push(old.slice(offset,offset+size));chunks.fresh.push(fresh.slice(offset,offset+size));}
    for(let round=0;round<2;round++)for(let chunk=0;chunk<chunks.existing.length;chunk++){
      const names=(round+chunk)%2?['fresh','existing']:['existing','fresh'];
      const versions=Object.entries(normalizers),offset=(round+chunk)%versions.length;
      for(const [version,fn]of [...versions.slice(offset),...versions.slice(0,offset)])for(const name of names){
        const input=chunks[name][chunk],start=performance.now(),before=process.threadCpuUsage(),output=input.map(fn).filter(Boolean);
        result.primitiveReads.push({name,version,round,chunk,inputRows:input.length,rows:output.length,start,end:performance.now(),...cpu(before)});}
      if(chunk%2===1)await wait(20);
    }
    result.oldDigestAfter=await digest(old);result.freshDigestAfter=await digest(fresh);
    result.ok=result.oldDigestAfter===result.oldDigest&&result.freshDigestAfter===result.freshDigest;
  }catch(error){result.ok=false;result.failures.push({name:error.name,code:error.code||null,message:error.message});}
  finally{
    await wait(20);for(const e of observer.takeRecords())result.gc.push({start:e.startTime,duration:e.duration,kind:e.detail?.kind});observer.disconnect();
    result.sourceAfter=identity();result.sourceUnchanged=JSON.stringify(result.sourceBefore)===JSON.stringify(result.sourceAfter);
    result.cacheUnchanged=this.records===old&&this.version===cacheVersion;result.heapAfter=v8.getHeapStatistics();
    for(const read of [...result.reads,...result.primitiveReads])read.gcMs=result.gc.reduce((sum,e)=>sum+Math.max(0,Math.min(read.end,e.start+e.duration)-Math.max(read.start,e.start)),0);
    result.ok=result.ok&&result.sourceUnchanged&&result.cacheUnchanged;result.finishedAt=new Date().toISOString();
  }
  return result;
}
