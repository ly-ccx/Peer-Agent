/** Sampled WALL estimates, not retired instructions or exact function CPU. Raw paths stay private. */
export function attributeProfileSpans(profile,clock,spans){
 if(!Number.isFinite(clock?.offsetMs)||!Number.isFinite(clock?.uncertaintyMs)||clock.uncertaintyMs<0||clock.uncertaintyMs>10||!Array.isArray(profile.nodes)||!Array.isArray(profile.samples)||!Array.isArray(profile.timeDeltas)||profile.nodes.length>100000||profile.samples.length>1000000||profile.samples.length!==profile.timeDeltas.length)throw Error('profile_span_contract');
 const nodes=new Map(),parents=new Map();for(const node of profile.nodes){if(nodes.has(node.id))throw Error('profile_duplicate_node');nodes.set(node.id,node);}
 for(const n of nodes.values())for(const id of n.children||[]){if(!nodes.has(id)||parents.has(id))throw Error('profile_parent_invalid');parents.set(id,n.id);}
 const paths=new Map();for(const id of nodes.keys()){let at=id,path=[],seen=new Set();while(at!==undefined){if(seen.has(at)||path.length>=128)throw Error('profile_parent_cycle_or_depth');seen.add(at);path.push({id:at,...nodes.get(at).callFrame});at=parents.get(at);}paths.set(id,path.reverse());}
 let t=profile.startTime/1000;const samples=[];for(let i=0;i<profile.samples.length;i++){const dt=profile.timeDeltas[i]/1000,id=profile.samples[i];if(!Number.isFinite(dt)||dt<0||!nodes.has(id))throw Error('profile_sample_invalid');samples.push({id,start:t+clock.offsetMs,end:t+dt+clock.offsetMs,dt});t+=dt;}
 if(!Number.isFinite(t)||!Number.isFinite(profile.endTime)||t>profile.endTime/1000+1)throw Error('profile_sample_clock');
 return spans.map(span=>{if(!Number.isFinite(span.start)||!Number.isFinite(span.end)||span.end<span.start)throw Error('profile_span_clock');
  const byLeaf=new Map();let ambiguous=0,possible=0,definite=0,estimated=0,unresolved=0;
  for(const s of samples){const u=clock.uncertaintyMs,maybe=s.end+u>=span.start&&s.end-u<=span.end,overlap=Math.max(0,Math.min(s.end,span.end)-Math.max(s.start,span.start));if(!maybe&&!overlap)continue;
   const yes=s.end-u>=span.start&&s.end+u<=span.end,path=paths.get(s.id),special=path.at(-1).functionName?.startsWith('(')||!path.at(-1).functionName;
   if(maybe){possible++;if(yes)definite++;else ambiguous++;}
   estimated+=overlap;if(special)unresolved+=overlap;
   const row=byLeaf.get(s.id)||{path,possibleSamples:0,definiteSamples:0,estimatedSampledWallMs:0,unresolved:special};row.possibleSamples+=maybe?1:0;row.definiteSamples+=yes?1:0;row.estimatedSampledWallMs+=overlap;byLeaf.set(s.id,row);
  }
  const leaves=[...byLeaf.values()].sort((a,b)=>b.estimatedSampledWallMs-a.estimatedSampledWallMs);
  // Exclusive leaves partition the estimate. Inclusive parents are deliberately not summed again.
  return{label:span.label,start:span.start,end:span.end,possibleSamples:possible,definiteSamples:definite,boundaryAmbiguousSamples:ambiguous,estimatedSampledWallMs:estimated,unresolvedSampledWallMs:unresolved,leaves,
   sufficientSamples:definite>=3,samplingConvention:'preceding-delta assigned to sampled leaf; clipped at span boundaries at midpoint offset',uncertaintyMs:clock.uncertaintyMs,notCpuOrInstructions:true};
 });
}
