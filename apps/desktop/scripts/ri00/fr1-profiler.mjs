/** Serialized with the recorder. One start, no business reads, and retained raw stop outcome. */
export function createFr1Profiler({emit, module = process.getBuiltinModule('inspector'), now = () => performance.now(),
  clock = () => ({performanceMs: performance.now(), hrtimeMs: Number(process.hrtime.bigint()) / 1e6})} = {}) {
  let session, timer, waitTimer, profile, pending, startedCpu;
  const state = {phase:'unused', startAttempts:0, commands:[], errors:[], disabled:false, startBefore:null,startAfter:null,stopBefore:null,stopAfter:null};
  const copy=()=>({...state,commands:[...state.commands],errors:[...state.errors]});
  function error(phase,e){state.errors.push({phase,message:String(e.message)});emit('profile-error',{phase,message:String(e.message)});}
  function post(method,params,done){state.commands.push(method);try{session.post(method,params,(e,r)=>done(e,r));}catch(e){done(e);}}
  function stop(reason='window'){
    clearTimeout(timer);clearTimeout(waitTimer);
    if(state.phase==='unused'||state.phase==='done'||state.phase==='stopping')return copy();
    if(state.phase==='armed'){state.phase='done';emit('profile-unused',{reason});return copy();}
    state.phase='stopping';state.stopBefore=clock();
    post('Profiler.stop',{},(e,r)=>{state.stopAfter=clock();if(e)error('stop',e);else profile=r?.profile;
      post('Profiler.disable',{},e=>{state.disabled=!e;if(e)error('disable',e);try{session.disconnect();}catch(e){error('disconnect',e);}
        if(startedCpu){const c=process.threadCpuUsage(startedCpu);state.wholeWindowCpuMs=(c.user+c.system)/1000;}
        state.phase='done';state.returned=Boolean(profile);state.reason=reason;emit('profile-finished',{state:copy()});});});
    return copy();
  }
  return {state:copy,
    arm(){if(state.phase!=='unused')throw Error('fr1_profile_one_attempt');state.phase='armed';emit('profile-armed',{});waitTimer=setTimeout(()=>stop('no-next-natural-entry'),30000);waitTimer.unref?.();return copy();},
    onNaturalEntry(){if(state.phase!=='armed')return;clearTimeout(waitTimer);state.phase='starting';state.startAttempts++;startedCpu=process.threadCpuUsage();
      try{session=new module.Session();session.connect();}catch(e){error('connect',e);state.phase='done';return;}
      post('Profiler.enable',{},e=>{if(e){error('enable',e);return stop('enable-error');}
        post('Profiler.setSamplingInterval',{interval:500},e=>{if(e){error('interval',e);return stop('interval-error');}
          state.startBefore=clock();post('Profiler.start',{},e=>{state.startAfter=clock();if(e){error('start',e);return stop('start-outcome-unknown');}
            state.phase='recording';emit('profile-started',{clock:state.startAfter});timer=setTimeout(()=>stop('window'),10000);timer.unref?.();});});});
    },stop,
    take(){if(state.phase!=='done'||pending)return pending||{state:copy(),profile:null};pending={state:copy(),profile:profile||null};return pending;},
    ack(){profile=null;pending=null;return true;}
  };
}

/** Both protocol endpoints must map inside the actual command intervals, never assume clock origins. */
export function fr1ProfileClock(profile,state){
  if(!profile||![state.startBefore,state.startAfter,state.stopBefore,state.stopAfter].every(c=>Number.isFinite(c?.performanceMs)))
    return {valid:false,reason:'missing-clock-boundary'};
  const lower=Math.max(state.startBefore.performanceMs-profile.startTime/1000,state.stopBefore.performanceMs-profile.endTime/1000),
    upper=Math.min(state.startAfter.performanceMs-profile.startTime/1000,state.stopAfter.performanceMs-profile.endTime/1000);
  return {valid:lower<=upper&&upper-lower<=2,lower,upper,widthMs:upper-lower,notProfilerNeutrality:true};
}
