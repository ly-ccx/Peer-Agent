import {qualifiedE3FastPair} from './e3-checkpoint.mjs';

/** Pure preregistered qualification contrast. It cannot establish the historical residual or field formation. */
export function evaluateE3DrainTarget(checkpoints) {
  const order=checkpoints.map(c=>c.mode).join(',');
  if(!['point,block,block,point','block,point,point,block'].includes(order))throw Error('e3_drain_fixed_schedule_required');
  const a=checkpoints.filter(c=>c.mode==='point'),b=checkpoints.filter(c=>c.mode==='block');
  const maxRange=c=>Math.max(...c.gate.summaries.map(s=>s.compatibleRange));
  const pointOnlyRangeFailures=a.every(c=>Object.values(c.validation).every(Boolean)&&c.calibrationStable
    &&c.gate.summaries.every(s=>s.compatible>=3)&&maxRange(c)>15&&c.gate.reason==='unmatched_gc_state_or_unstable_warm');
  const blockFastPairQualified=qualifiedE3FastPair(b[0],b[1]);
  const rangeImprovementMs=(maxRange(a[0])+maxRange(a[1])-maxRange(b[0])-maxRange(b[1]))/2;
  return {pointOnlyRangeFailures,blockFastPairQualified,rangeImprovementMs,
    supported:pointOnlyRangeFailures&&blockFastPairQualified&&rangeImprovementMs>=5,notFieldCause:true};
}
