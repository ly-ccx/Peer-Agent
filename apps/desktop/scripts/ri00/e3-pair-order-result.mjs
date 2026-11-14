import {summarizeDenseBlock} from './dense-residual.mjs';
import {cadenceReadMetrics, cadenceBlockGaps} from './e3-cadence-result.mjs';

const sum = a => a.reduce((s, v) => s + v, 0);
const compatible = p => summarizeDenseBlock([p.row, p.row]).compatible === 1;
const gc = p => cadenceReadMetrics(p).fullGcSignature;
const fields = ['evidenceUserMs', 'evidenceSystemMs', 'evidenceTotalCpuMs', 'rootUserMs', 'rootSystemMs',
  'rootTotalCpuMs', 'remainderUserMs', 'remainderSystemMs', 'instructions', 'cycles'];
const subtract = (a, b) => Object.fromEntries(fields.map(k => [k,
  Number.isFinite(a?.[k]) && Number.isFinite(b?.[k]) ? a[k] - b[k] : null]));

export function orderBlockStatistics(block) {
  const summary = summarizeDenseBlock(block.points.map(p => p.row)), points = block.points.slice(1).filter(compatible)
    .map((p, i) => ({p, i, user: cadenceReadMetrics(p).evidenceUserMs})).sort((a, b) => a.user - b.user || a.i - b.i);
  if (!points.length) return {summary, anchors: [], joint: null};
  const selected = points.length % 2 ? [points[points.length >> 1].p] :
    [points[points.length / 2 - 1].p, points[points.length / 2].p];
  const metrics = selected.map(cadenceReadMetrics), joint = Object.fromEntries(fields.map(k => [k,
    metrics.every(m => Number.isFinite(m[k])) ? sum(metrics.map(m => m[k])) / selected.length : null]));
  return {summary, joint, anchors: selected.map(p => ({ticketId: p.row.ticketId,
    weight: 1 / selected.length, fullGcSignature: gc(p)})), notMarginalComponentMedians: true};
}
export function actualOrderValid(cell) {
  const expected = cell.arm === 'A' ? ['target', 'conditioning'] : ['conditioning', 'target'];
  if (cell.executed?.length !== 2 || cell.executed.some((b, i) => b.role !== expected[i])) return false;
  const [a, b] = cell.executed.map(b => b.controllerBoundary);
  return Boolean(a && b && [a.startedAtMs, a.finishedAtMs, b.startedAtMs, b.finishedAtMs].every(Number.isFinite) &&
    [a.startJournalSeq, a.endJournalSeq, b.startJournalSeq, b.endJournalSeq].every(n => Number.isSafeInteger(n) && n > 0) && a.host !== b.host && a.startJournalSeq < a.endJournalSeq &&
    a.endJournalSeq < b.startJournalSeq && b.startJournalSeq < b.endJournalSeq &&
    a.startedAtMs <= a.finishedAtMs && a.finishedAtMs <= b.startedAtMs && b.startedAtMs <= b.finishedAtMs &&
    cell.executed.every(block => block.sequence.length === 10 && block.calibration.length === 3));
}
export function orderCellStatistics(cell) {
  const target = orderBlockStatistics(cell.targetBlock), conditioning = orderBlockStatistics(cell.conditioningBlock);
  return {target, conditioning, normalized: subtract(target.joint, conditioning.joint)};
}
function matchingDescription(left, right) {
  const a = left.targetBlock.points.slice(1).filter(compatible), b = right.targetBlock.points.slice(1).filter(compatible),
    used = new Set(), pairs = [];
  for (const x of a) {
    const i = b.findIndex((y, i) => !used.has(i) && gc(y) === gc(x));
    if (i < 0) continue;
    used.add(i); const y = b[i];
    pairs.push({leftTicket: x.row.ticketId, rightTicket: y.row.ticketId,
      left: cadenceReadMetrics(x), right: cadenceReadMetrics(y)});
  }
  return {pairs, descriptiveOnly: true, noPerPassWorkOrPhysicalFrequencyAttribution: true};
}
export function evaluatePairOrderTarget(cells, order) {
  if (cells.length !== 4 || cells.map(c => c.arm).join('') !== order || !['ABBA', 'BAAB'].includes(order))
    return {controlsQualified: false, reason: 'fixed-cells-incomplete'};
  const stats = cells.map(orderCellStatistics), sameArm = ['A', 'B'].map(arm => {
    const ids = [...order].flatMap((a, i) => a === arm ? [i] : []), [a, b] = ids.map(i => stats[i]);
    return {arm, cells: ids, target: subtract(b.target.joint, a.target.joint),
      conditioning: subtract(b.conditioning.joint, a.conditioning.joint), normalized: subtract(b.normalized, a.normalized)};
  });
  const contrasts = [[0, 1], [2, 3]].map(([l, r]) => {
    const ai = cells[l].arm === 'A' ? l : r, bi = cells[l].arm === 'B' ? l : r;
    return {left: l, right: r, A: ai, B: bi, rawTarget: subtract(stats[bi].target.joint, stats[ai].target.joint),
      rawConditioning: subtract(stats[bi].conditioning.joint, stats[ai].conditioning.joint),
      normalized: subtract(stats[bi].normalized, stats[ai].normalized),
      targetMedianGapDifferenceMs: Math.abs(cadenceBlockGaps(cells[ai].targetBlock).medianMs -
        cadenceBlockGaps(cells[bi].targetBlock).medianMs), matching: matchingDescription(cells[l], cells[r])};
  });
  const within = (d, limit) => Number.isFinite(d) && Math.abs(d) <= limit;
  const checks = {originalBlocks: cells.every(c => c.pair.passed), actualOrder: cells.every(actualOrderValid),
    actualGaps: cells.every(c => [c.targetBlock, c.conditioningBlock].every(b => cadenceBlockGaps(b).minimumMs >= 150)),
    comparableTargetGaps: contrasts.every(c => c.targetMedianGapDifferenceMs <= 5),
    originalNormalizedReturn: sameArm.every(c => within(c.normalized.evidenceUserMs, 2)),
    rawTargetReturn: sameArm.every(c => within(c.target.evidenceUserMs, 2)),
    rawConditioningReturn: sameArm.every(c => within(c.conditioning.evidenceUserMs, 2))};
  return {checks, controlsQualified: Object.values(checks).every(Boolean), stats, sameArm, contrasts,
    conditioningIsNotUntreatedReference: true, notFieldCause: true};
}
export function evaluatePairOrderCampaign(targets) {
  const controlsQualified = targets.length === 2 && targets.every(t => t.result.controlsQualified),
    values = targets.flatMap(t => t.result.contrasts?.map(c => c.rawTarget.evidenceUserMs) || []),
    effectCriterion = values.length === 4 && values.every(v => Number.isFinite(v) && Math.abs(v) >= 8) &&
      new Set(values.map(Math.sign)).size === 1;
  return {controlsQualified, orderSensitivitySupported: controlsQualified && effectCriterion,
    rawContrastsMs: values, fixedEffectCriterionPassed: effectCriterion, notFieldCause: true};
}
