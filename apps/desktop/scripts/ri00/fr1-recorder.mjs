/** Passive-only serialized module. No method can request a business read or native priming. */
export function installFr1Recorder({store,roots,entries,foreground=()=>null,notify=()=>{},ownerId='unit',expectedWorkspaceId=null,epoch='unverified',identityComplete=false,
  durationMs=1800000,leaseMs=90000,bounds={},profilerFactory,cleanupNotice=()=>true,closeInspectorOnWatchdog=false}={}) {
  if(!store||!Array.isArray(roots)||!roots.length||roots.length>8||!Array.isArray(entries)||entries.length>16||
    durationMs<100||durationMs>1800000||leaseMs<100||leaseMs>90000)throw Error('fr1_install_contract');
  const fs=process.getBuiltinModule('fs'),path=process.getBuiltinModule('path'),crypto=process.getBuiltinModule('crypto'),
    {AsyncLocalStorage}=process.getBuiltinModule('async_hooks'),{performance,PerformanceObserver}=process.getBuiltinModule('perf_hooks'),
    {isPromise,isProxy}=process.getBuiltinModule('util').types,getCallSites=process.getBuiltinModule('util').getCallSites,als=new AsyncLocalStorage();
  if(typeof getCallSites!=='function')throw Error('fr1_native_call_sites_unavailable');
  const cap={roots:1500,entries:10000,gc:65536,bytes:8388608,stacks:256,stackBytes:8388608,frames:96,stackLength:32768,parentDepth:128,rootSelfMs:2,selfMs:3000,...bounds};
  const indexFile=path.join(store.getStoreDir(),'evidence-index.jsonl'),originalPlan=store.getPlan,originalIndex=store.listEvidenceIndex;
  if(typeof originalPlan!=='function'||typeof originalIndex!=='function')throw Error('fr1_store_ports');
  const installed=[],stackIds=new Map(),scripts=new Map(),inFlightEntries=new Set();let stackBytes=0,records=[],retainedBytes=0,seq=0,rootId=0,entryId=0,gcCount=0,activeRoot=null,lastPortRun=null,pending,lease,timer,heartbeat,notice;
  let stopped=false,stopReason,restored,metadataErrors=0,lost=0,selfMs=0,stopAfterRoot;
  const state={ownerId,roots:0,entries:0,acks:0,lastAckSeq:0,controlledRequests:0,heapGetters:0,nativeCalls:0,rawRootUserMs:0,rawRootSystemMs:0,stackCaptures:0,stackMaterializations:0};
  const cpu=()=>{const c=process.threadCpuUsage();return(c.user+c.system)/1000;};
  const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
  const stamp=()=>{const s=fs.statSync(indexFile,{bigint:true});return hash(JSON.stringify(['dev','ino','size','mtimeNs','ctimeNs'].map(k=>String(s[k]))));};
  function note(){if(notice||stopped)return;notice=setImmediate(()=>{notice=null;const before=cpu();try{notify({kind:'data',at:performance.now()});}catch{fatal('notification-owner-or-delivery');}selfMs+=cpu()-before;});}
  function append(kind,value){const row={seq:seq+1,kind,at:performance.now(),value};const bytes=Buffer.byteLength(JSON.stringify(row));
    if(retainedBytes+bytes>cap.bytes-8192){lost++;fatal('unacknowledged-cap');return null;}
    seq++;records.push(row);retainedBytes+=bytes;note();return row.seq;}
  function own(){return installed.every(x=>x.object[x.key]===x.replacement);}
  function fatal(why){stopAfterRoot??=why;if(!activeRoot&&api)api.stop(why);}
  function captureStack(){const sites=getCallSites(cap.frames,{sourceMap:false});state.stackCaptures++;let sourceBytes=0,renderUpperBytes=64;
    // Every call captures its current complete location vector. Only presentation is interned;
    // neither a first-kind stack nor a receiver/function object is kept in the dictionary.
    const frames=sites.map(f=>{const prior=scripts.get(f.scriptId);if(prior!==undefined&&prior!==f.scriptName)throw Error('fr1_script_identity_changed');
      if(prior===undefined){const value={scriptId:f.scriptId,scriptName:f.scriptName},n=Buffer.byteLength(JSON.stringify(value));
        if(scripts.size>=cap.stacks||stackBytes+n>cap.stackBytes)throw Error('fr1_script_dictionary_cap');scripts.set(f.scriptId,f.scriptName);stackBytes+=n;sourceBytes+=n;append('script',value);}
      renderUpperBytes+=3*(f.functionName.length+f.scriptName.length+f.scriptId.length)+64;
      return[f.functionName,f.scriptId,f.lineNumber,f.columnNumber];});
    const signature=JSON.stringify(frames),truncated=frames.length>=cap.frames||Buffer.byteLength(signature)+sourceBytes>cap.stackLength||renderUpperBytes>cap.stackLength;
    if(truncated){fatal('stack-capture-cap');return{id:null,truncated:true};}
    if(stackIds.has(signature))return{id:stackIds.get(signature),truncated:false};
    const n=Buffer.byteLength(signature);if(stackIds.size>=cap.stacks||stackBytes+n>cap.stackBytes){fatal('stack-dictionary-cap');return {id:null,truncated:true};}
    const id=stackIds.size+1;stackIds.set(signature,id);stackBytes+=n;state.stackMaterializations++;append('stack',{id,encoding:'node-location-tuples-v1',captureKind:'current-synchronous-JS',asyncParents:'mapped-ALS-only',nativeAndUnmappedAsyncFramesNotInvented:true,frames,truncated:false});return{id,truncated:false};
  }
  function scope(args){const p=args[0];if(!p||typeof p!=='object'||isProxy(p))return hash(JSON.stringify([Array.isArray(p)?'array':typeof p]));
    const get=k=>Object.getOwnPropertyDescriptor(p,k)?.value;
    return hash(JSON.stringify(['workspaceId','parentConversationId','sessionId'].map(k=>typeof get(k)==='string'?get(k):null)));}
  function boundScope(args,parent){if(!expectedWorkspaceId)return true;const p=args[0];if(Array.isArray(p))return p.length===1&&p[0]===expectedWorkspaceId;if(p&&typeof p==='object'&&!isProxy(p)){const value=Object.getOwnPropertyDescriptor(p,'workspaceId')?.value;if(typeof value==='string')return value===expectedWorkspaceId;}return parent?.scopeBound===true;}
  function charge(n){selfMs+=Math.max(0,n);if(selfMs>cap.selfMs)fatal('probe-cpu-cap');}
  function wrap(object,key,replacement){if(!object||typeof object[key]!=='function'||installed.some(x=>x.object===object&&x.key===key))throw Error('fr1_duplicate-or-missing-port');
    const original=object[key],desired=replacement(original);object[key]=desired;if(object[key]!==desired)throw Error('fr1_port_not_writable');installed.push({object,key,original,replacement:object[key]});}
  function port(kind){if(!activeRoot)return;const r=activeRoot;if(kind==='plan')r.planCalls++;
    if(lastPortRun?.kind===kind)lastPortRun.count++;else if(r.portSequence.length<64){lastPortRun={kind,count:1};r.portSequence.push(lastPortRun);}else{r.chainIncomplete=true;fatal('port-run-cap');}}
  const profiler=profilerFactory?profilerFactory({emit:(k,v)=>append(k,v)}):null;
  function runRoot(fn,receiver,args,method,indexOnly=false){
    if(stopped)return Reflect.apply(fn,receiver,args);
    if(activeRoot){append('nested-root',{rootId:activeRoot.id,method});return Reflect.apply(fn,receiver,args);}
    try{profiler?.onNaturalEntry();}catch(e){metadataErrors++;fatal('profile-start:'+e.message);return Reflect.apply(fn,receiver,args);}
    const metadataStart=cpu();let r;
    try{if(!own())throw Error('method-owner-changed');const context=als.getStore();
      r={id:++rootId,entryId:context?.id??null,rootMethod:method,scope:context?.scope||scope(args),epoch,identityComplete:identityComplete&&boundScope(args,context),
        foregroundDelivery:context?.foregroundDelivery??null,entryStack:captureStack(),evidence:[],planCalls:0,portSequence:[],phase:profiler?.state().phase||'unused',
        rootIncludesNestedRecorderCpu:true,spanCpuExcludesOwnPrePostMetadata:true,sourceBefore:stamp(),chainIncomplete:!context||Boolean(context?.chainIncomplete),indexOnly};
      append('root-start',{id:r.id,entryId:r.entryId,rootMethod:method,scope:r.scope,epoch,phase:r.phase});
    }catch(e){metadataErrors++;fatal('root-start:'+e.message);charge(cpu()-metadataStart);return Reflect.apply(fn,receiver,args);}
    r.start=performance.now();const before=process.threadCpuUsage();r.preSelfMs=cpu()-metadataStart;activeRoot=r;lastPortRun=null;
    let value,error;
    try{value=Reflect.apply(fn,receiver,args);return value;}catch(e){error=e;r.readFailure=true;throw e;}
    finally{r.end=performance.now();const c=process.threadCpuUsage(before);activeRoot=null;lastPortRun=null;r.userMs=c.user/1000;r.systemMs=c.system/1000;r.totalCpuMs=r.userMs+r.systemMs;
      const afterStart=cpu();try{r.sourceAfter=stamp();r.rows=value instanceof Map?value.size:Array.isArray(value)?value.length:null;r.asyncRoot=isPromise(value);
        if(value&&!r.asyncRoot){const bytes=Buffer.from(JSON.stringify(value instanceof Map?[...value]:value));r.outputBytes=bytes.length;if(r.outputBytes<=1048576)r.outputSha256=hash(bytes);else r.identityComplete=false;}
        if(r.asyncRoot)r.identityComplete=false;
        r.evidenceUserMs=r.evidence.reduce((s,e)=>s+e.userMs,0);r.evidenceSystemMs=r.evidence.reduce((s,e)=>s+e.systemMs,0);
        r.remainderUserMs=r.userMs-r.evidenceUserMs;r.remainderSystemMs=r.systemMs-r.evidenceSystemMs;
        r.chainIncomplete||=r.entryStack.truncated||r.evidence.some(e=>e.entryStack.truncated);
      }catch(e){metadataErrors++;r.metadataFailure=String(e.message);r.identityComplete=false;}
      r.postSelfMs=cpu()-afterStart;r.instrumentationCpuMs=r.preSelfMs+r.postSelfMs+r.evidence.reduce((s,e)=>s+e.selfMs,0)+(r.planCounterWallUpperMs||0);
      state.roots++;state.rawRootUserMs+=r.userMs;state.rawRootSystemMs+=r.systemMs;
      if(r.instrumentationCpuMs>cap.rootSelfMs)stopAfterRoot??='per-root-probe-cpu-cap';
      if(state.roots>=cap.roots)stopAfterRoot??='natural-root-cap';
      const keepStart=cpu();append('root',r);const totalSelf=r.instrumentationCpuMs+cpu()-keepStart;state.lastRootSelfCpuMs=totalSelf;if(totalSelf>cap.rootSelfMs)stopAfterRoot??='per-root-probe-cpu-cap';charge(totalSelf);
      if(stopAfterRoot)api.stop(stopAfterRoot);
    }
  }
  let observer;
  const api={
    renew(){if(stopped)throw Error('fr1_stopped:'+stopReason);if(!own()){api.stop('method-owner-changed');throw Error('fr1_owner_changed');}clearTimeout(lease);lease=setTimeout(()=>api.stop('controller-lease'),leaseMs);lease.unref?.();return api.state();},
    state(){return {...state,nowMs:performance.now(),stopped,stopReason,restored,metadataErrors,lost,selfCpuMs:selfMs,retainedBytes,lastSeq:seq,stackBytes,stackSignatures:stackIds.size,
      inFlightEntries:inFlightEntries.size,pending:Boolean(pending),activeRoot:activeRoot?.id??null,ownersIntact:own(),ownersRestored:installed.every(x=>x.object[x.key]===x.original),profiler:profiler?.state()||{phase:'unused',startAttempts:0}};},
    async take(){if(pending)return pending;await new Promise(r=>setImmediate(()=>setImmediate(r)));const before=cpu();
      pending={records:records.map(r=>({...r})),throughSeq:seq,clock:{performanceMs:performance.now(),hrtimeMs:Number(process.hrtime.bigint())/1e6},state:api.state()};charge(cpu()-before);return pending;},
    ack({throughSeq}){if(throughSeq===state.lastAckSeq&&(!pending||pending.throughSeq!==throughSeq))return true;if(!pending||throughSeq!==pending.throughSeq)throw Error('fr1_ack_identity');const before=cpu();records=records.filter(r=>r.seq>throughSeq);retainedBytes=records.reduce((s,r)=>s+Buffer.byteLength(JSON.stringify(r)),0);pending=null;state.lastAckSeq=throughSeq;state.acks++;charge(cpu()-before);return true;},
    setEpoch({value,complete}){if(activeRoot)throw Error('fr1_epoch_inside_root');epoch=value;identityComplete=Boolean(complete);append('source-epoch',{epoch,identityComplete});return true;},
    armProfile(){if(stopped||activeRoot)throw Error('fr1_profile_admission');if(!profiler)throw Error('fr1_profile_unavailable');return profiler.arm();},
    stopProfile(){return profiler?.stop('controller')||{phase:'unused'};},takeProfile(){return profiler?.take()||{state:{phase:'unused'},profile:null};},ackProfile(){return profiler?.ack()||true;},
    stop(reason='controller'){if(stopped)return api.state();stopped=true;stopReason=reason;clearTimeout(timer);clearTimeout(lease);clearInterval(heartbeat);clearImmediate(notice);
      observer?.disconnect();profiler?.stop('recorder-stop');restored=true;
      for(const x of [...installed].reverse()){if(x.object[x.key]===x.replacement)x.object[x.key]=x.original;else if(x.object[x.key]!==x.original)restored=false;}
      als.disable();stackIds.clear();scripts.clear();stackBytes=0;append('recorder-stop',{reason,restored});
      try{notify({kind:'stopped',reason,at:performance.now()});}catch{metadataErrors++;}
      try{state.bindingRestored=cleanupNotice();}catch{state.bindingRestored=false;}
      if(closeInspectorOnWatchdog&&reason!=='controller')setTimeout(()=>process.getBuiltinModule('inspector').close(),5000).unref();
      return api.state();}
  };
  try{
    for(const {object,key,kind,transport}of entries)wrap(object,key,original=>function(...args){
      if(stopped)return Reflect.apply(original,this,args);const before=cpu(),parent=als.getStore();let e;
      try{if(!own())throw Error('entry-owner-changed');e={id:++entryId,parentId:parent?.id??null,kind,scope:scope(args),scopeBound:boundScope(args,parent),depth:(parent?.depth||0)+1,
        stack:captureStack(),start:performance.now(),foregroundDelivery:transport?foreground(args[0]):parent?.foregroundDelivery??null};e.chainIncomplete=e.stack.truncated||e.depth>cap.parentDepth||Boolean(parent?.chainIncomplete)||(!parent&&!transport);append('entry-start',e);inFlightEntries.add(e.id);state.entries++;
        if(state.entries>=cap.entries)stopAfterRoot??='entry-cap';}
      catch(error){metadataErrors++;fatal('entry-start:'+error.message);charge(cpu()-before);return Reflect.apply(original,this,args);}
      charge(cpu()-before);
      const finish=completion=>{inFlightEntries.delete(e.id);const n=cpu();append('entry-end',{id:e.id,completion,end:performance.now(),afterStop:stopped});charge(cpu()-n);if(stopAfterRoot&&!activeRoot)api.stop(stopAfterRoot);};
      return als.run(e,()=>{let value;const beforeCall=process.threadCpuUsage();try{value=Reflect.apply(original,this,args);}catch(error){const c=process.threadCpuUsage(beforeCall);append('entry-sync-prefix',{id:e.id,userMs:c.user/1000,systemMs:c.system/1000,completion:'threw'});finish('threw');throw error;}const c=process.threadCpuUsage(beforeCall);append('entry-sync-prefix',{id:e.id,userMs:c.user/1000,systemMs:c.system/1000,completion:isPromise(value)?'promise-returned':'returned',notAsyncContinuationCpu:true});
        if(isPromise(value))Promise.prototype.then.call(value,()=>finish('fulfilled'),()=>finish('rejected'));else finish('returned');return value;});
    });
    for(const {object,key,kind}of roots)wrap(object,key,original=>function(...args){return runRoot(original,this,args,kind);});
    wrap(store,'getPlan',original=>function(...args){const before=performance.now();port('plan');if(activeRoot)activeRoot.planCounterWallUpperMs=(activeRoot.planCounterWallUpperMs||0)+performance.now()-before;return Reflect.apply(original,this,args);});
    wrap(store,'listEvidenceIndex',original=>function(...args){
      if(stopped)return Reflect.apply(original,this,args);if(!activeRoot)return runRoot(original,this,args,'outside-index',true);
      const r=activeRoot,meta=cpu();port('index');let stack;try{stack=captureStack();}catch(e){metadataErrors++;r.chainIncomplete=true;stack={id:null,truncated:true};}
      const before=process.threadCpuUsage(),pre=(before.user+before.system)/1000-meta,start=performance.now();let value,failed=false;
      try{value=Reflect.apply(original,this,args);return value;}catch(e){failed=true;throw e;}
      finally{const end=performance.now(),c=process.threadCpuUsage(before),tail=(before.user+before.system+c.user+c.system)/1000,e={position:r.evidence.length,start,end,userMs:c.user/1000,systemMs:c.system/1000,rows:Array.isArray(value)?value.length:null,readFailure:failed,entryStack:stack,selfMs:0};r.evidence.push(e);e.selfMs=pre+cpu()-tail;}
    });
    observer=new PerformanceObserver(list=>{const before=cpu();for(const e of list.getEntries()){if(++gcCount>cap.gc){fatal('gc-cap');break;}append('gc',{start:e.startTime,duration:e.duration,kind:e.detail?.kind});}charge(cpu()-before);});observer.observe({entryTypes:['gc']});
    heartbeat=setInterval(()=>{const before=cpu();try{notify({kind:'heartbeat',at:performance.now(),seq,foregroundDelivery:Boolean(foreground())});}catch(e){metadataErrors++;fatal('heartbeat-notification');}charge(cpu()-before);},250);heartbeat.unref?.();
    timer=setTimeout(()=>api.stop('hard-deadline'),durationMs);timer.unref?.();api.renew();append('recorder-installed',{epoch,identityComplete,durationMs,leaseMs,limits:cap});
  }catch(error){api.stop('install-failure');throw error;}
  return api;
}
