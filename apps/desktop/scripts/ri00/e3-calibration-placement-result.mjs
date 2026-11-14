import {evaluatePBlockPair} from './e3-p-result.mjs';
import {orderCellStatistics} from './e3-pair-order-result.mjs';
import {cadenceBlockGaps, cadenceReadMetrics} from './e3-cadence-result.mjs';
import {summarizeDenseBlock} from './dense-residual.mjs';
const median = a => {if (!a.length || !a.every(Number.isFinite)) return null; const s = [...a].sort((a,b) => a-b); return (s[(s.length-1)>>1]+s[s.length>>1])/2;};
const total = c => c.userMs + c.systemMs;
const within = (n, cap) => Number.isFinite(n) && Math.abs(n) <= cap;
export function placementBlockTiming(block) {
  const seq = block.sequence, positions = block.hashPositions, expected = block.role === 'target' && block.arm === 'B' ? [2,5,8] : [null,null,null];
  const shape = seq?.length === 10 && positions?.length === 3 && block.calibration?.length === 3 &&
    positions.every((p,i) => p.beforeReadIndex === expected[i] && JSON.stringify(p.value) === JSON.stringify(block.calibration[i]));
  if (!shape) return {valid: false, reason: 'fixed-position-count'};
  const intervals = positions.map(p => ({beforeReadIndex: p.beforeReadIndex, start: p.value.start, end: p.value.end}));
  const valid = intervals.every((h,i) => Number.isFinite(h.start) && Number.isFinite(h.end) && h.start < h.end &&
    total(positions[i].value) > 0 && seq.every(p => h.end <= p.row.start || h.start >= p.row.end) &&
    (h.beforeReadIndex === null ? h.start >= seq[9].row.end :
      h.start >= seq[h.beforeReadIndex-1].row.end && h.end <= seq[h.beforeReadIndex].row.start) &&
    (i === 0 || intervals[i-1].end <= h.start));
  return {valid, intervals, gaps: cadenceBlockGaps(block)};
}
export function placementCellOrderValid(cell) {
  const blocks = cell.executed;
  if (blocks?.length !== 2 || (blocks[0] !== cell.targetBlock && JSON.stringify(blocks[0]) !== JSON.stringify(cell.targetBlock)) || (blocks[1] !== cell.conditioningBlock && JSON.stringify(blocks[1]) !== JSON.stringify(cell.conditioningBlock)) ||
    blocks.map(b=>b.role).join(',') !== 'target,conditioning' || blocks.some(b=>b.arm!==cell.arm)) return false;
  const [a,b] = blocks.map(b=>b.controllerBoundary);
  return Boolean(a && b && a.host !== b.host && [a.startedAtMs,a.finishedAtMs,b.startedAtMs,b.finishedAtMs].every(Number.isFinite) &&
    [a.startJournalSeq,a.endJournalSeq,b.startJournalSeq,b.endJournalSeq].every(n=>Number.isSafeInteger(n)&&n>0) &&
    a.startJournalSeq<a.endJournalSeq && a.endJournalSeq<b.startJournalSeq && b.startJournalSeq<b.endJournalSeq &&
    a.startedAtMs<=a.finishedAtMs && a.finishedAtMs<=b.startedAtMs && b.startedAtMs<=b.finishedAtMs);
}
function sameGc(left,right) {
  const compatible = p => summarizeDenseBlock([p.row,p.row]).compatible===1;
  const a=left.points.slice(1).filter(compatible), b=right.points.slice(1).filter(compatible), used=new Set(), pairs=[];
  for(const p of a){const x=cadenceReadMetrics(p),i=b.findIndex((q,i)=>!used.has(i)&&cadenceReadMetrics(q).fullGcSignature===x.fullGcSignature);
    if(i<0)continue;used.add(i);pairs.push({left:x,right:cadenceReadMetrics(b[i])});}
  return {pairs,descriptiveOnly:true};
}
export function evaluatePlacementTarget(t, expected) {
  if(t.cells.length!==4 || t.cells.map(c=>c.arm).join('')!==t.order || !['ABBA','BAAB'].includes(t.order))
    return {diagnosticControlsValid:false,reason:'fixed-cells-incomplete'};
  const init=t.initialCalibration, base=median(init?.target?.map(total)||[])/median(init?.conditioning?.map(total)||[]),
    pairs=t.cells.map(c=>evaluatePBlockPair(c.targetBlock,c.conditioningBlock,expected,base)), stats=t.cells.map(orderCellStatistics),
    timing=t.cells.map(c=>c.executed.map(placementBlockTiming)),
    sameArm=['A','B'].map(arm=>{const ids=[...t.order].flatMap((x,i)=>x===arm?[i]:[]),[a,b]=ids.map(i=>stats[i]);
      return {arm,cells:ids,rawTargetUserMs:b.target.joint?.evidenceUserMs-a.target.joint?.evidenceUserMs,
        rawConditioningUserMs:b.conditioning.joint?.evidenceUserMs-a.conditioning.joint?.evidenceUserMs,
        normalizedUserMs:b.normalized.evidenceUserMs-a.normalized.evidenceUserMs};}),
    contrasts=[[0,1],[2,3]].map(([l,r])=>{const a=t.cells[l].arm==='A'?l:r,b=t.cells[l].arm==='B'?l:r;
      return {A:a,B:b,ARangeMs:stats[a].target.summary.compatibleRange,BRangeMs:stats[b].target.summary.compatibleRange,
        rangeReductionMs:stats[a].target.summary.compatibleRange-stats[b].target.summary.compatibleRange,
        targetMedianGapDifferenceMs:Math.abs(cadenceBlockGaps(t.cells[a].targetBlock).medianMs-cadenceBlockGaps(t.cells[b].targetBlock).medianMs),
        rawA:stats[a],rawB:stats[b],matching:sameGc(t.cells[l].targetBlock,t.cells[r].targetBlock)};});
  // Warm failure is the dependent outcome. Keep its original classification, never convert it to admission.
  const checks={initialCalibration:init?.target?.length===3&&init?.conditioning?.length===3&&Number.isFinite(base)&&base>0,
    graphSourcePmcMetadata:pairs.every(p=>Object.entries(p.checks).filter(([k])=>k!=='unchangedWarmGate').every(([,v])=>v)),
    compatibleWarm:pairs.every(p=>p.summaries.every(s=>s.compatible>=3)),
    actualOrder:t.cells.every(placementCellOrderValid),hashPositionsAndNoOverlap:timing.every(bs=>bs.every(b=>b.valid)),
    actualGaps:timing.every(bs=>bs.every(b=>b.gaps?.minimumMs>=150)),comparableGaps:contrasts.every(c=>c.targetMedianGapDifferenceMs<=5),
    rawTargetReturn:sameArm.every(s=>within(s.rawTargetUserMs,2)),rawConditioningReturn:sameArm.every(s=>within(s.rawConditioningUserMs,2)),
    normalizedReturn:sameArm.every(s=>within(s.normalizedUserMs,2))};
  return {checks,diagnosticControlsValid:Object.values(checks).every(Boolean),originalPairs:pairs,stats,timing,sameArm,contrasts,
    calibrationBaseline:base,performanceQualified:false,f0AdmissionIssued:false,fieldWindowAllowed:false,notFieldCause:true};
}
export function evaluatePlacementCampaign(targets) {
  const valid=targets.length===2&&targets.every(t=>t.result?.diagnosticControlsValid), contrasts=targets.flatMap(t=>t.result?.contrasts||[]),
    badBaseline=contrasts.length===4&&contrasts.every(c=>Number.isFinite(c.ARangeMs)&&c.ARangeMs>15),
    effect=contrasts.length===4&&contrasts.every(c=>Number.isFinite(c.BRangeMs)&&c.BRangeMs<=15&&c.rangeReductionMs>=5);
  return {diagnosticControlsValid:valid,diagnosticOutcome:!valid?'invalid':!badBaseline?'baseline-not-reproduced':effect?'supported':'hypothesis-not-supported',
    allFourABadBaselineReproduced:badBaseline,fixedRangeCriterionMet:effect,performanceQualified:false,f0AdmissionIssued:false,fieldWindowAllowed:false,notFieldCause:true};
}
