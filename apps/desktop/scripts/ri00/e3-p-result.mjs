import{summarizeDenseBlock}from'./dense-residual.mjs';
const median=a=>{const s=[...a].sort((x,y)=>x-y);return(s[(s.length-1)>>1]+s[s.length>>1])/2;};
export function evaluatePBlockPair(target,reference,expected,calibrationBaseline=null){
 const blocks=[target,reference],summaries=blocks.map(b=>summarizeDenseBlock(b.points.map(p=>p.row))),calibrationRatio=median(target.calibration.map(c=>c.userMs+c.systemMs))/median(reference.calibration.map(c=>c.userMs+c.systemMs));
 const checks={graph:blocks.every(b=>b.points.length===8&&b.points.every(({row:r})=>r.samplingSchema==='controlled-heap-v1'&&r.readKind==='dense'&&!r.readFailure&&!r.metadataFailure&&r.sourceBefore===r.sourceAfter&&r.rows===expected.sessions&&r.planCalls===expected.planCalls&&r.outputSha256===expected.outputSha256&&r.evidence.length===12&&r.evidence.every(e=>e.rows===expected.evidenceRows)&&!r.ledgerTruncated)),
  source:blocks.every(b=>b.points.every(p=>p.row.sourceBefore===target.points[0].row.sourceBefore)),pmc:blocks.every(b=>b.points.every(p=>p.pmc?.available&&p.pmc.exclusiveWindow)),
  unchangedWarmGate:summaries.every(s=>s.compatible>=3&&s.compatibleRange<=15),metadata:blocks.every(b=>median(b.points.map(p=>p.row.instrumentationCpuMs??p.row.metadataCpuMs))<=2),
  calibration:Number.isFinite(calibrationRatio)&&calibrationRatio>0&&(calibrationBaseline===null||Math.abs(calibrationRatio/calibrationBaseline-1)<=.10)};
 return{passed:Object.values(checks).every(Boolean),checks,summaries,calibrationRatio,deltaMs:summaries.every(s=>s.median!==null)?summaries[0].median-summaries[1].median:null,notG2:true};
}
export function evaluatePTiming(pairs){
 if(pairs.length!==3) return{passed:false,reason:'fixed-off-on-off-incomplete'};
 const d=pairs.map(p=>p.deltaMs),overheadMs=d[1]-(d[0]+d[2])/2,offReturnDriftMs=d[2]-d[0];
 const checks={allBlocks:pairs.every(p=>p.passed),timingOverhead:Number.isFinite(overheadMs)&&Math.abs(overheadMs)<=2,offReturnDrift:Number.isFinite(offReturnDriftMs)&&Math.abs(offReturnDriftMs)<=2};
 return{passed:Object.values(checks).every(Boolean),checks,deltasMs:d,overheadMs,offReturnDriftMs,notCause:true};
}
