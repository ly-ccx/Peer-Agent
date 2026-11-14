/** No correction is applied to the original gate or historical sample. Raw rounding is retained. */
export function analyzeFr1Stages(meter,root,state) {
  const errors=[];
  if(meter.invalid)errors.push(meter.invalid);
  if(meter.openStages.length)errors.push('open-stages');
  const byId=new Map(meter.stages.map(x=>[x.id,x])),epsilonMs=.004,stages=[];
  if(!root)errors.push('root-missing');
  for(const row of meter.stages){
    if(!row.closed){errors.push('unclosed:'+row.id);continue;}
    const userMs=(row.endUser-row.beginUser)/1000,systemMs=(row.endSystem-row.beginSystem)/1000,cpuMs=userMs+systemMs;
    const operationWallUpperMs=row.endEntryWall-row.beginExitWall,bracketWallMs=row.endClockEndWall-row.beginClockWall;
    const observerWallUpperMs=(row.beginExitWall-row.beginClockWall)+(row.endClockEndWall-row.endEntryWall);
    if(cpuMs>bracketWallMs+epsilonMs||cpuMs< -epsilonMs)errors.push('cpu-clock-coherence:'+row.id);
    if(userMs< -.002||systemMs< -.002)errors.push('cpu-component-regressed:'+row.id);
    if(row.parent){const p=byId.get(row.parent);if(!p||row.beginClockWall<p.beginClockWall||row.endClockEndWall>p.endClockEndWall)errors.push('parent-window:'+row.id);}
    const children=meter.stages.filter(x=>x.parent===row.id&&x.closed);
    const childUserMs=children.reduce((s,x)=>s+(x.endUser-x.beginUser)/1000,0),childSystemMs=children.reduce((s,x)=>s+(x.endSystem-x.beginSystem)/1000,0);
    stages.push({...row,userMs,systemMs,cpuMs,operationWallUpperMs,bracketWallMs,observerWallUpperMs,
      operationCpuLowerMs:Math.max(0,cpuMs-observerWallUpperMs-epsilonMs),operationCpuUpperMs:Math.max(0,Math.min(cpuMs+epsilonMs,operationWallUpperMs)),
      exclusiveUserMs:userMs-childUserMs,exclusiveSystemMs:systemMs-childSystemMs,exclusiveCpuMs:cpuMs-childUserMs-childSystemMs,
      cpuIncludesEndingMeasurementClock:true,exactOperationCpu:false});
  }
  const names=[...new Set(stages.map(x=>x.name))],groups=names.map(name=>{const rows=stages.filter(x=>x.name===name&&x.rootId===root?.id);
    return{name,count:rows.length,userMs:rows.reduce((s,x)=>s+x.userMs,0),systemMs:rows.reduce((s,x)=>s+x.systemMs,0),inclusiveCpuMs:rows.reduce((s,x)=>s+x.cpuMs,0),
      exclusiveCpuMs:rows.reduce((s,x)=>s+x.exclusiveCpuMs,0),operationWallUpperMs:rows.reduce((s,x)=>s+x.operationWallUpperMs,0),
      operationCpuLowerMs:rows.reduce((s,x)=>s+x.operationCpuLowerMs,0),operationCpuUpperMs:rows.reduce((s,x)=>s+x.operationCpuUpperMs,0)};});
  const coarseNames=['root.pre','root.post','root.keep','span.pre','span.post'];
  const coarse=stages.filter(x=>coarseNames.includes(x.name)&&x.rootId===root?.id);
  if(root)for(const name of ['root.pre','root.post','root.keep'])if(coarse.filter(x=>x.name===name).length!==1)errors.push('coarse-coverage:'+name);
  const rawCpuSelfMs=root?root.preSelfMs+root.postSelfMs+root.evidence.reduce((s,e)=>s+e.selfMs,0)+(state.lastRootSelfCpuMs-root.instrumentationCpuMs):null;
  const coveredCpuMs=coarse.reduce((s,x)=>s+x.cpuMs,0),cpuRemainderMs=rawCpuSelfMs===null?null:rawCpuSelfMs-coveredCpuMs;
  if(root&&coarse.filter(x=>x.name==='span.pre').length!==root.evidence.length)errors.push('span-pre-coverage');
  if(root&&coarse.filter(x=>x.name==='span.post').length!==root.evidence.length)errors.push('span-post-coverage');
  if(root&&cpuRemainderMs< -epsilonMs*coarse.length)errors.push('negative-uncovered-cpu');
  const clocks=['original','boundary'].map(role=>{const rows=meter.clocks.filter(x=>x.role.startsWith(role)),covered=rows.filter(x=>coarse.some(c=>x.beginWall>=c.beginClockWall&&x.endWall<=c.endClockEndWall));return{role,count:rows.length,wallUpperMs:rows.reduce((s,x)=>s+x.endWall-x.beginWall,0),coveredMetadataCount:covered.length,coveredMetadataWallUpperMs:covered.reduce((s,x)=>s+x.endWall-x.beginWall,0),exactCpuUnknown:true,coveredClocksNotAddedAgainToCpu:true};});
  return{valid:errors.length===0,errors,stages,groups,clocks,coverage:{rawCpuSelfMs,coveredCpuMs,cpuRemainderMs,
    originalMixedChargeMs:state?.lastRootSelfCpuMs,planWallUpperMs:root?.planCounterWallUpperMs??null,
    densePlanPerformanceNowCalls:root?root.planCalls*2:null,densePerformanceClockCpuUnknown:true,
    noCpuWallMixingInStageSums:true},historicalRootNotBackfilled:true,observerNeutralityProven:false,
    functionalQualification:false,fieldAdmission:false,productCauseEstablished:false};
}
