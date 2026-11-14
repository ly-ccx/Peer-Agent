import assert from 'node:assert/strict';
import {reconcileFr1SelfWindows} from './fr1-stage-replay.mjs';

/** Partition sealed native snapshot intervals; never turn API wall envelopes into CPU. */
export function partitionFr1StageGaps(meter,root,state){
  const self=reconcileFr1SelfWindows(meter,root,state),byId=new Map(meter.stages.map(s=>[s.id,s]));
  const point=(s,end=false)=>({user:s[end?'endUser':'beginUser'],system:s[end?'endSystem':'beginSystem']});
  const clock=id=>{const c=meter.clocks.find(c=>c.id===id);assert.ok(c);
    if(!c.isDelta)return c;
    assert.equal(c.role,'original-8');
    const before=meter.clocks.filter(x=>x.id<c.id&&x.role==='original-7'&&!x.isDelta).at(-1);assert.ok(before);
    return{user:c.user+before.user,system:c.system+before.system};
  };
  const rows=[];
  function gap(bucket,s,from,to,a,b,position){
    const userUs=b.user-a.user,systemUs=b.system-a.system;
    // Keep signed quantized components. Do not clamp or fit a residual to a target.
    rows.push({bucket,coarse:s.name,span:s.spanPosition,stageId:s.id,position,from,to,userUs,systemUs,totalUs:userUs+systemUs,
      originalAndNewMeterWorkMixed:true,exactObserverCpuUnknown:true});
  }
  for(const w of self.windows){const s=byId.get(w.stageId);
    gap('outside-coarse',s,w.startClockId,s.beginClockId,clock(w.startClockId),point(s),'before');
    gap('outside-coarse',s,s.endClockId,w.endClockId,point(s,true),clock(w.endClockId),'after');
    const children=meter.stages.filter(x=>x.parent===s.id).sort((a,b)=>a.beginClockId-b.beginClockId);
    let prev=point(s),prevLabel=s.name+'.begin',pos='before-first';
    for(const c of children){gap('coarse-bookkeeping',s,prevLabel,c.name+'.begin',prev,point(c),pos);
      prev=point(c,true);prevLabel=c.name+'.end';pos='between';}
    gap('coarse-bookkeeping',s,prevLabel,s.name+'.end',prev,point(s,true),children.length?'after-last':'no-child');
  }
  const sum=xs=>({userUs:xs.reduce((n,x)=>n+x.userUs,0),systemUs:xs.reduce((n,x)=>n+x.systemUs,0),totalUs:xs.reduce((n,x)=>n+x.totalUs,0),intervals:xs.length});
  const buckets=['outside-coarse','coarse-bookkeeping'].map(bucket=>{
    const xs=rows.filter(x=>x.bucket===bucket);return{bucket,...sum(xs),byCoarse:[...new Set(xs.map(x=>x.coarse))].map(coarse=>({coarse,...sum(xs.filter(x=>x.coarse===coarse))})),
      byPosition:[...new Set(xs.map(x=>x.position))].map(position=>({position,...sum(xs.filter(x=>x.position===position))}))};
  });
  assert.ok(Math.abs(buckets[0].totalUs/1000-self.uncoveredCpuMs)<1e-8);
  return{buckets,rows,allRawCpuIntervalsRetained:true,clockWallNotSubtracted:true,observerNeutralityProven:false,
    noPureClockOrBookkeepingAttribution:true,historical2387msNotBackfilled:true,functionalQualification:false,fieldAdmission:false};
}
