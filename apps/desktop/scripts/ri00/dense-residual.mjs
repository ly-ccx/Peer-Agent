const median=values=>{const s=[...values].sort((a,b)=>a-b),n=s.length;return n%2?s[n>>1]:(s[n/2-1]+s[n/2])/2;};
const newSpace=row=>row.heapBefore.spaces.find(s=>s.space_name==='new_space')?.space_size;
export function summarizeDenseBlock(rows){
  const warm=rows.slice(1),compatible=warm.filter(row=>row.gc.major===0&&row.gc.incremental===0&&newSpace(row)===67108864
    &&row.heapAfter.spaces.find(s=>s.space_name==='new_space')?.space_size===67108864
    &&row.processUserMs+row.processSystemMs-row.userMs-row.systemMs<120);
  const measure=list=>list.map(row=>row.evidence.reduce((s,e)=>s+e.userMs,0));
  const values=measure(compatible);return {all:rows.length,warm:warm.length,compatible:compatible.length,
    fullWarmMedian: warm.length?median(measure(warm)):null,median:values.length?median(values):null,
    compatibleRange:values.length?Math.max(...values)-Math.min(...values):null};
}
/** Pure gate: same process/reference and source before any temporal CPU comparison. */
export function advanceDenseResidual(state,checkpoint){
  const {identity,mainA,reference,mainB}=checkpoint;
  if(!checkpoint.valid||!identity)return {...state,status:'invalidated',reason:'identity_or_measurement_failure'};
  if(state.identity&&state.identity!==identity)return {...state,status:'invalidated',reason:'process_source_or_reference_changed'};
  const groups=[mainA,reference,mainB];
  if(groups.some(rows=>rows.length<4||rows.some(row=>row.readFailure||row.metadataFailure||row.sourceBefore!==row.sourceAfter||row.evidence.length!==12
    ||row.evidence.some(e=>e.rows!==mainA[0].evidence[0].rows)||row.sourceBefore!==mainA[0].sourceBefore||row.outputSha256!==mainA[0].outputSha256)))
    return {...state,status:'invalidated',reason:'read_graph_or_output_changed'};
  const summaries=groups.map(summarizeDenseBlock);
  if(summaries.some(g=>g.compatible<3||g.compatibleRange>15))return {...state,identity,status:state.baseline?'armed':'waiting-baseline',reason:'unmatched_gc_state_or_unstable_warm',summaries,streak:0,deltas:null};
  const [a,r,b]=summaries,deltas=[a.median-r.median,b.median-r.median];
  if(checkpoint.calibrationStable===false)return {...state,identity,status:state.baseline?'armed':'waiting-baseline',reason:'calibration_drift_or_probe_overhead',summaries,streak:0,deltas};
  if(!state.baseline){
    if(deltas.every(d=>d>=25&&d/r.median>=.08))return {...state,identity,status:'slow-at-entry',reason:'dense_residual_precedes_baseline',deltas,summaries};
    if(deltas.some(d=>d>=15)||Math.abs(a.median-b.median)>15)return {...state,identity,status:'waiting-baseline',reason:'fast_baseline_not_stable',deltas,summaries};
    return {identity,status:'armed',baseline:deltas,streak:0,deltas,summaries};
  }
  const candidate=deltas.every((d,i)=>d>=25&&d/r.median>=.08&&d-state.baseline[i]>=25);
  const streak=candidate?(state.streak||0)+1:0;
  return {...state,identity,status:streak>=2?'confirmed-transition':streak?'suspect':'armed',streak,deltas,summaries,
    reason:candidate?'persistent_dense_residual':'criterion_not_met'};
}
