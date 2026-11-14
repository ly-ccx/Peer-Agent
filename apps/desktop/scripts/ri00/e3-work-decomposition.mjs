import{decodePassWork}from'./pass-work.mjs';
import{summarizeDenseBlock}from'./dense-residual.mjs';
const sum=a=>a.reduce((s,x)=>s+x,0),median=a=>{const b=[...a].sort((x,y)=>x-y),n=b.length;return n%2?b[n>>1]:(b[n/2-1]+b[n/2])/2;};
const compatible=r=>summarizeDenseBlock([r,r]).compatible===1;
const gcKey=r=>JSON.stringify([r.gc.minor,r.gc.major,r.gc.incremental,r.evidence.map(e=>[e.gc.minor,e.gc.major,e.gc.incremental])]);
/** One deterministic decomposition of the original median statistic; not independent position medians or causal effects. */
export function medianRootVector(points){
 if(!points.length)throw Error('median_root_empty');const sorted=points.map((p,i)=>({p,i,total:sum(p.row.evidence.map(e=>e.userMs))})).sort((a,b)=>a.total-b.total||a.i-b.i),n=sorted.length,
  selected=n%2?[sorted[n>>1]]:[sorted[n/2-1],sorted[n/2]];
 const vector=selected[0].p.row.evidence.map((_,i)=>sum(selected.map(x=>x.p.row.evidence[i].userMs))/selected.length);
 return{vector,total:sum(selected.map(x=>x.total))/selected.length,anchors:selected.map(x=>({label:x.p.label,weight:1/selected.length,gcSignature:gcKey(x.p.row)})),causalAttribution:false};
}
/** Exact log-mean accounting identity T=I*(C/I)*(T/C). These terms are NOT causal effects or hardware frequency. */
export function decomposeWork(before,after){
 const read=x=>({i:Number(x.instructions),c:Number(x.cycles),t:x.cpuMs}),a=read(before),b=read(after);
 if(Object.values(a).concat(Object.values(b)).some(x=>!Number.isFinite(x)||x<=0))return{available:false,reason:'nonpositive-or-unknown-counter'};
 const logT=Math.log(b.t/a.t),scale=Math.abs(logT)<1e-12?(a.t+b.t)/2:(b.t-a.t)/logT;
 const instructionsMs=scale*Math.log(b.i/a.i),cyclesPerInstructionMs=scale*Math.log((b.c/b.i)/(a.c/a.i)),cpuMsPerCycleMs=scale*Math.log((b.t/b.c)/(a.t/a.c));
 return{available:true,deltaCpuMs:b.t-a.t,instructionsMs,cyclesPerInstructionMs,cpuMsPerCycleMs,
  reconciliationErrorMs:b.t-a.t-instructionsMs-cyclesPerInstructionMs-cpuMsPerCycleMs,causalAttribution:false,notHardwareFrequency:true};
}
/** Audit the full fixed experiment. OFF has outer counters only; absent per-pass instructions are never imputed. */
export function auditPassWorkExperiment(report){
 const targets=[],passes=[];
 for(const c of report.cases.filter(c=>c.mode==='production')){
  const blocks=c.blocks.map((b,bi)=>{const summary=summarizeDenseBlock(b.points.map(p=>p.row)),warm=b.points.slice(1).filter(p=>compatible(p.row));
   for(const p of b.points)if(b.enabled){const w=decodePassWork(p.row.passWork);for(let i=0;i<12;i++)passes.push({target:c.label,block:bi,label:p.label,position:i,compatible:compatible(p.row),gc:p.row.evidence[i].gc,...w.passes[i]});}
   const points=b.points.map(p=>{const outer={instructions:String(p.pmc.levels.reduce((s,l)=>s+BigInt(l.instructions),0n)),cycles:String(p.pmc.levels.reduce((s,l)=>s+BigInt(l.cycles),0n)),cpuMs:p.pmc.cpuMs};
    return{label:p.label,enabled:b.enabled,compatible:compatible(p.row),row:p.row,outer,work:b.enabled?decodePassWork(p.row.passWork):null,
     encoding:{passValueChars:sum(p.row.passWork.values.map(s=>s.length)),passWorkBytes:Buffer.byteLength(JSON.stringify(p.row.passWork)),uniqueValueStrings:new Set(p.row.passWork.values).size}};});
   return{index:bi,enabled:b.enabled,summary,points,medianRootCpuMs:median(warm.map(p=>p.row.userMs+p.row.systemMs)),medianMetadataCpuMs:median(warm.map(p=>p.row.instrumentationCpuMs)),
    calibrationCpuMs:median(b.calibration.map(x=>x.userMs+x.systemMs)),medianEncodingBytes:median(points.slice(1).filter(p=>p.compatible).map(p=>p.encoding.passWorkBytes))};});
  const on=blocks.filter(b=>b.enabled),off=blocks.filter(b=>!b.enabled),comparisons=on.map((b,i)=>{
   const other=off[i],bp=b.points.slice(1).filter(p=>p.compatible),ap=other.points.slice(1).filter(p=>p.compatible),medCounter=a=>({instructions:String(Math.round(median(a.map(p=>Number(p.outer.instructions))))),cycles:String(Math.round(median(a.map(p=>Number(p.outer.cycles))))),cpuMs:median(a.map(p=>p.outer.cpuMs))});
   const aVector=medianRootVector(ap),bVector=medianRootVector(bp),positions=bVector.vector.map((x,i)=>x-aVector.vector[i]);
   return{onBlock:b.index,offBlock:other.index,evidenceUserDeltaMs:b.summary.median-other.summary.median,medianGatePositions:{before:aVector,after:bVector,deltas:positions,reconciliationErrorMs:b.summary.median-other.summary.median-sum(positions),sameGcAcrossAnchors:new Set([...aVector.anchors,...bVector.anchors].map(x=>x.gcSignature)).size===1},rootOuterMedianDecomposition:decomposeWork(medCounter(ap),medCounter(bp)),
    fixedHashCpuRatio:b.calibrationCpuMs/other.calibrationCpuMs,metadataCpuDeltaMs:b.medianMetadataCpuMs-other.medianMetadataCpuMs,encodingBytesDelta:b.medianEncodingBytes-other.medianEncodingBytes,
    caveat:'marginal medians are different roots and GC mixtures, not a matched causal pair'};});
  const ordered=blocks.flatMap(b=>b.enabled?b.points.slice(1).filter(p=>p.compatible).map(p=>({...p,block:b.index})):[]),pairs=[];
  for(let i=0;i<ordered.length;i++)for(let j=i+1;j<ordered.length;j++){const a=ordered[i],b=ordered[j];if(gcKey(a.row)!==gcKey(b.row))continue;
   pairs.push({before:a.label,after:b.label,sameBlock:a.block===b.block,evidenceUserDeltaMs:sum(b.row.evidence.map(e=>e.userMs))-sum(a.row.evidence.map(e=>e.userMs)),
    reportedEvidenceSystemDeltaMs:sum(b.row.evidence.map(e=>e.systemMs))-sum(a.row.evidence.map(e=>e.systemMs)),root:decomposeWork(a.work.root,b.work.root),passes:a.work.passes.map((p,k)=>decomposeWork(p,b.work.passes[k])),remainder:decomposeWork(a.work.remainder,b.work.remainder)});}
  const warmExtremes=blocks.map(b=>{const p=b.points.slice(1).filter(p=>p.compatible).sort((a,z)=>sum(a.row.evidence.map(e=>e.userMs))-sum(z.row.evidence.map(e=>e.userMs))),lo=p[0],hi=p.at(-1);
   return{block:b.index,enabled:b.enabled,low:lo.label,high:hi.label,evidenceUserDeltaMs:b.summary.compatibleRange,sameGcSignature:gcKey(lo.row)===gcKey(hi.row),outer:decomposeWork(lo.outer,hi.outer),
    passes:lo.work?lo.work.passes.map((x,k)=>decomposeWork(x,hi.work.passes[k])):null,missingPassCounters:!lo.work,notMatchedUnlessSameGc:true};});
  targets.push({label:c.label,blocks:blocks.map(({points,...b})=>b),comparisons,pairs,warmExtremes,rawPointEncoding:blocks.flatMap(b=>b.points.map(({label,enabled,encoding})=>({label,enabled,...encoding})))});
 }
 return{kind:'sealed-N-work-and-rate-accounting-not-cause',passes,targets,counts:{passes:passes.length,compatiblePasses:passes.filter(p=>p.compatible).length,compatibleWarmPasses:sum(targets.map(t=>t.blocks.filter(b=>b.enabled).reduce((n,b)=>n+b.summary.compatible*12,0))),sameGcChronologicalPairs:sum(targets.map(t=>t.pairs.length))},
  knownDesignDifferences:['ON executes 52 extra JS-object-returning threadCpuUsage calls per root; physical heap allocation not measured','ON encodes cumulative counter values; OFF encodes zero-filled buffer, different string values and serialized byte counts'],
  missing:['OFF per-pass instructions','matched allocation history','hot execution stacks','same-process qualified fast-to-slow formation'],noNewProductReads:true};
}
