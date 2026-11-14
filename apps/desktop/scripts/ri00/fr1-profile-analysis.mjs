/** Definite samples only; sampled wall occupancy is never presented as additional thread CPU. */
export function analyzeFr1Profile(profile,clock,records){
 if(!clock.valid)return{valid:false,reason:'clock-unqualified',spans:[],notCausalAttribution:true};
 if(profile.samples?.length!==profile.timeDeltas?.length)return{valid:false,reason:'sample-clock-length',spans:[],notCausalAttribution:true};
 const nodes=new Map(profile.nodes.map(x=>[x.id,x])),samples=[];let time=profile.startTime;
 for(let i=0;i<profile.samples.length;i++){time+=profile.timeDeltas[i];samples.push({node:profile.samples[i],low:time/1000+clock.lower,high:time/1000+clock.upper});}
 const spans=[];
 for(const entry of records){if(entry.kind!=='root')continue;const r=entry.value;
  for(const e of r.evidence){const certain=samples.filter(s=>s.low>=e.start&&s.high<=e.end);if(!certain.length)continue;const calls=new Map();
   for(const sample of certain){const f=nodes.get(sample.node)?.callFrame;if(!f)continue;const k=JSON.stringify([f.functionName,f.url,f.lineNumber]);calls.set(k,(calls.get(k)||0)+1);}
   spans.push({rootId:r.id,position:e.position,start:e.start,end:e.end,definiteSamples:certain.length,hotspotReportAllowed:certain.length>=10,
    topFrames:[...calls].sort((a,b)=>b[1]-a[1]).slice(0,64).map(([key,samples])=>({frame:JSON.parse(key),samples})),observedUnderProfiler:true});
  }
 }
 return{valid:true,spans,reportedPerPassMinimumSamples:10,qualifiedSpanCount:spans.filter(x=>x.hotspotReportAllowed).length,notCausalAttribution:true,firstTransitionNotReconstructed:true};
}
