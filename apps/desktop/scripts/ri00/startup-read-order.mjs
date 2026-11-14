/** Observe early reads only. No values, file identities or filenames enter the result. */
export function installStartupReadOrder(deps,options){
  if(!Number.isInteger(options.durationMs)||options.durationMs<100||options.durationMs>60000)throw new Error('bounded_startup_duration_required');
  const {fs,path,now,timers,syncExports}=deps,store=path.resolve(options.storeRoot),stores=new Set([store,fs.realpathSync(store)]),original=fs.readFileSync;
  const state={kind:'startup-fs-order-not-normalization-call-count',started:now(),events:[],counts:{plan:0,index:0},dropped:0,classificationLimitHits:0,stopped:false,restored:null};
  const directories=new Map();
  const stacks={plan:0,index:0};
  let tracedIndex=false;
  function captureStack(){
    const descriptor=Object.getOwnPropertyDescriptor(Error,'stackTraceLimit');
    try{Object.defineProperty(Error,'stackTraceLimit',{configurable:true,writable:true,enumerable:descriptor?.enumerable??false,value:64});
      const stack=new Error('ri00-startup-read').stack;return typeof stack==='string'?stack.slice(0,65536):null;
    }catch{state.stackCaptureErrors=(state.stackCaptureErrors||0)+1;return null;}
    finally{try{if(descriptor)Object.defineProperty(Error,'stackTraceLimit',descriptor);else delete Error.stackTraceLimit;}catch{state.stackRestoreErrors=(state.stackRestoreErrors||0)+1;}}
  }
  const wrapped=function(file,...args){
    let kind;
    // Keep path conversion and observation failures out of the production result path.
    try{if(typeof file==='string'){
      const resolved=path.resolve(file);
      const candidate=path.basename(resolved)==='evidence-index.jsonl'?'index':resolved.endsWith('.json')?'plan':null;
      if(candidate){const directory=path.dirname(resolved);let matches=stores.has(directory)||directories.get(directory);
        if(!stores.has(directory)&&!directories.has(directory)){
          if(directories.size>=256)state.classificationLimitHits++;
          else{try{matches=stores.has(fs.realpathSync(directory));}catch{matches=false;}directories.set(directory,matches);}
        }
        if(matches)kind=candidate;
      }
    }}catch{}
    if(!kind||state.stopped)return Reflect.apply(original,this,[file,...args]);
    const row={sequence:state.counts.plan+state.counts.index+1,kind,start:now(),countsBefore:{...state.counts}};state.counts[kind]++;
    if(stacks[kind]++<4){row.stack=captureStack();row.stackLimit=64;row.stackFrames=typeof row.stack==='string'?row.stack.split('\n').filter(x=>/^\s+at /.test(x)).length:null;}
    if(kind==='index'&&!tracedIndex&&typeof deps.traceIndex==='function'){
      tracedIndex=true;try{deps.traceIndex('ri00-first-index-entry');}catch{state.rootTraceErrors=(state.rootTraceErrors||0)+1;}
    }
    try{const value=Reflect.apply(original,this,[file,...args]);row.resultUnits=typeof value==='string'?value.length:Buffer.isBuffer(value)?value.length:null;return value;}
    catch(error){row.failed=true;throw error;}
    finally{row.end=now();if(state.events.length<256||stacks[kind]<=4)state.events.push(row);else state.dropped++;}
  };
  try{fs.readFileSync=wrapped;syncExports();}
  catch(error){if(fs.readFileSync===wrapped){fs.readFileSync=original;try{syncExports();}catch{}}throw error;}
  let timer;
  const probe={peek:()=>state,stop(){if(state.stopped)return state;state.stopped=true;timers.clearTimeout(timer);
    if(fs.readFileSync===wrapped){fs.readFileSync=original;syncExports();state.restored=true;}else state.restored=fs.readFileSync===original;
    state.finished=now();return state;}};
  timer=timers.setTimeout(()=>probe.stop(),options.durationMs);timer.unref?.();return probe;
}
