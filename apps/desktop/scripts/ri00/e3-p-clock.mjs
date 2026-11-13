/** P-specific three-clock interval witness. No shared-origin assumption or relaxed 2ms gate. */
export function mapPProfileClock(profile,markers){
 if(!Array.isArray(markers)||markers.length!==2||new Set(markers.map(m=>m.name)).size!==2||!markers.some(m=>m.name==='e3BoundaryStart')||!markers.some(m=>m.name==='e3BoundaryEnd'))throw Error('p_clock_two_markers_required');
 if(!Array.isArray(profile.nodes)||!Array.isArray(profile.samples)||profile.samples.length!==profile.timeDeltas?.length||profile.samples.length>100000||profile.nodes.length>100000)throw Error('p_clock_profile_invalid');
 const nodes=new Map(profile.nodes.map(n=>[n.id,n]));if(nodes.size!==profile.nodes.length)throw Error('p_clock_duplicate_node');
 const parent=new Map();for(const n of nodes.values())for(const id of n.children||[]){if(!nodes.has(id)||parent.has(id))throw Error('p_clock_parent_invalid');parent.set(id,n.id);}
 for(const id of nodes.keys()){let at=id;const seen=new Set();while(at!==undefined){if(seen.has(at)||seen.size>=128)throw Error('p_clock_parent_cycle');seen.add(at);at=parent.get(at);}}
 const owned=new Map(),samples=new Map();for(const m of markers){const roots=profile.nodes.filter(n=>n.callFrame.functionName===m.name);if(roots.length!==1)throw Error('p_clock_marker_ambiguous');const q=[roots[0].id];while(q.length){const id=q.pop();if(owned.has(id))throw Error('p_clock_marker_overlap');owned.set(id,m.name);q.push(...(nodes.get(id).children||[]));}samples.set(m.name,[]);}
 let t=profile.startTime/1000;for(let i=0;i<profile.samples.length;i++){const dt=profile.timeDeltas[i]/1000;if(!Number.isFinite(dt)||dt<0||!nodes.has(profile.samples[i]))throw Error('p_clock_sample_invalid');t+=dt;samples.get(owned.get(profile.samples[i]))?.push(t);}
 if(!Number.isFinite(t)||t>profile.endTime/1000+1)throw Error('p_clock_sample_end_invalid');
 const perf=[],hr=[],bridge=[];for(const m of markers){const s=samples.get(m.name);if(s.length<3)throw Error('p_clock_marker_sparse');for(const x of[m.before,m.after]){if(!x||![x.hrBefore,x.performanceMs,x.hrAfter].every(Number.isFinite)||x.hrBefore>x.hrAfter)throw Error('p_clock_stamp_invalid');bridge.push([x.performanceMs-x.hrAfter,x.performanceMs-x.hrBefore]);}
  if(m.before.performanceMs>m.after.performanceMs||m.before.hrAfter>m.after.hrBefore)throw Error('p_clock_marker_order');perf.push([m.before.performanceMs-s[0],m.after.performanceMs-s.at(-1)]);hr.push([m.before.hrBefore-s[0],m.after.hrAfter-s.at(-1)]);}
 const intersect=xs=>{const lower=Math.max(...xs.map(x=>x[0])),upper=Math.min(...xs.map(x=>x[1]));if(!Number.isFinite(lower)||!Number.isFinite(upper)||lower>upper)throw Error('p_clock_interval_empty');return{lower,upper,widthMs:upper-lower};};
 const hrToPerformance=intersect(bridge),profileToHr=intersect(hr),directPerformance=intersect(perf),profileToPerformance=intersect([[directPerformance.lower,directPerformance.upper],[profileToHr.lower+hrToPerformance.lower,profileToHr.upper+hrToPerformance.upper]]);
 if(profileToPerformance.widthMs>2||profileToHr.widthMs>2||hrToPerformance.widthMs>2)throw Error('p_clock_width_rejected');
 return{profileToPerformance,profileToHr,hrToPerformance,offsetMs:(profileToPerformance.lower+profileToPerformance.upper)/2,uncertaintyMs:profileToPerformance.widthMs/2,markers:markers.map(m=>({name:m.name,samples:samples.get(m.name).length})),notSharedOriginAssumption:true};
}
