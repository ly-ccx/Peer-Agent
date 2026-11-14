/** Join only the unique browser-main thread ID; never attribute process-wide PMCs to it. */
export function browserMainCounterDelta(before,after,timebase,measuredCpuMs){
  const a=before.threads.filter(row=>row.category==='browser-main'),b=after.threads.filter(row=>row.category==='browser-main');
  if(a.length!==1||b.length!==1||a[0].id!==b[0].id)return {available:false,reason:'main_thread_identity_unverified'};
  if(!a[0].perLevel||!b[0].perLevel||a[0].perLevel.length!==b[0].perLevel.length)return {available:false,reason:'thread_counts_unavailable'};
  const levels=[];
  for(let i=0;i<a[0].perLevel.length;i++){
    const x=a[0].perLevel[i],y=b[0].perLevel[i];if(x.name!==y.name)return {available:false,reason:'perf_level_identity_changed'};
    const delta={name:x.name};
    for(const key of ['instructions','cycles','userTicks','systemTicks','energyNj']){
      if(!/^\d+$/.test(x[key])||!/^\d+$/.test(y[key])||BigInt(y[key])<BigInt(x[key]))return {available:false,reason:'counter_not_monotonic'};
      delta[key]=String(BigInt(y[key])-BigInt(x[key]));
    }
    delta.cpuMs=Number(BigInt(delta.userTicks)+BigInt(delta.systemTicks))*timebase.numer/timebase.denom/1e6;
    levels.push(delta);
  }
  const cpuMs=levels.reduce((sum,x)=>sum+x.cpuMs,0),outsideMeasuredCpuMs=cpuMs-measuredCpuMs;
  return {available:true,levels,cpuMs,outsideMeasuredCpuMs,
    exclusiveWindow:Math.abs(outsideMeasuredCpuMs)<=Math.max(2,measuredCpuMs*.05)};
}
