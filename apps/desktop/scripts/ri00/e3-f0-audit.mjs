import { summarizeDenseBlock } from './dense-residual.mjs';

const sum = (values, key) => values.reduce((total, value) => total + value[key], 0);
const range = values => values.length ? Math.max(...values) - Math.min(...values) : null;
const distribution = values => ({ n: values.length, min: values.length ? Math.min(...values) : null,
  max: values.length ? Math.max(...values) : null, range: range(values) });
function rejection(row, index) {
  const reasons = [];
  if (index === 0) reasons.push('first-point');
  if (row.gc.major !== 0 || row.gc.incremental !== 0) reasons.push('observed-major-or-incremental');
  if ([row.heapBefore, row.heapAfter].some(h => h.spaces.find(s => s.space_name === 'new_space')?.space_size !== 67108864)) reasons.push('new-space-size');
  if (row.processUserMs + row.processSystemMs - row.userMs - row.systemMs >= 120) reasons.push('other-thread-cpu');
  return reasons;
}
/** Offline accounting only. GC wall overlap is never subtracted from user CPU or used to requalify a point. */
export function auditE3F0(report) {
  const blocks = report.targets.flatMap(target => {
    const checkpoint = target.checkpoints.find(c => c?.label === 'F0');
    if (!checkpoint) throw Error('f0_audit_missing_checkpoint');
    return ['mainA', 'reference', 'mainB'].map(role => {
      const block = checkpoint[role];
      if (block.points.length !== 8) throw Error('f0_audit_incomplete_block');
      const points = block.points.map(({ row, pmc }, index) => {
        if (row.evidence.length !== 12 || row.readFailure || row.metadataFailure || !pmc.available || !pmc.exclusiveWindow) throw Error('f0_audit_invalid_point');
        const cpuMs = sum(pmc.levels, 'cpuMs');
        const instructions = pmc.levels.reduce((n, level) => n + Number(BigInt(level.instructions)), 0);
        const cycles = pmc.levels.reduce((n, level) => n + Number(BigInt(level.cycles)), 0);
        if (![instructions, cycles].every(Number.isSafeInteger) || cpuMs <= 0) throw Error('f0_audit_counter_range');
        return { index, rejectedBy: rejection(row, index), evidenceUserMs: sum(row.evidence, 'userMs'),
          rootUserMs: row.userMs, rootSystemMs: row.systemMs,
          nonEvidenceUserMs: row.userMs - sum(row.evidence, 'userMs'),
          rootMinor: row.gc.minor, rootGcWallOverlapMs: row.gc.observedOverlapMs,
          evidenceMinorOverlaps: sum(row.evidence.map(e => e.gc), 'minor'),
          evidenceGcWallOverlapMs: sum(row.evidence.map(e => e.gc), 'observedOverlapMs'),
          evidence: row.evidence.map(e => ({ userMs: e.userMs, systemMs: e.systemMs, minorOverlaps: e.gc.minor, gcWallOverlapMs: e.gc.observedOverlapMs })),
          rootInstructions: instructions, rootCycles: cycles, rootCounterCpuMs: cpuMs,
          cyclesPerCounterCpuMs: cycles / cpuMs,
          efficiencyCpuMs: pmc.levels.filter(l => l.name === 'Efficiency').reduce((n, l) => n + l.cpuMs, 0),
          metadataCpuMs: row.instrumentationCpuMs ?? row.metadataCpuMs,
          newSpaceUsedBeforeBytes: row.heapBefore.spaces.find(s => s.space_name === 'new_space').space_used_size,
          heapUsedBeforeBytes: row.heapBefore.used,
          gapAfterPreviousRootMs: index ? row.start - block.points[index - 1].row.end : null,
        };
      });
      const compatible = points.filter(p => p.rejectedBy.length === 0);
      if (!compatible.length) throw Error('f0_audit_no_compatible_points');
      const sorted = [...compatible].sort((a, b) => a.evidenceUserMs - b.evidenceUserMs), low = sorted[0], high = sorted.at(-1);
      const original = summarizeDenseBlock(block.points.map(p => p.row));
      if (Math.abs(original.compatibleRange - (high.evidenceUserMs - low.evidenceUserMs)) > 1e-8) throw Error('f0_audit_gate_disagreement');
      return { target: target.label, role, original, points,
        extremes: { lowIndex: low.index, highIndex: high.index, evidenceUserDeltaMs: high.evidenceUserMs - low.evidenceUserMs,
          rootUserDeltaMs: high.rootUserMs - low.rootUserMs,
          rootCpuDeltaMs: high.rootUserMs + high.rootSystemMs - low.rootUserMs - low.rootSystemMs,
          nonEvidenceUserDeltaMs: high.nonEvidenceUserMs - low.nonEvidenceUserMs,
          rootMinor: [low.rootMinor, high.rootMinor], evidenceMinorOverlaps: [low.evidenceMinorOverlaps, high.evidenceMinorOverlaps],
          rootInstructionsChangeFraction: high.rootInstructions / low.rootInstructions - 1,
          rootCyclesChangeFraction: high.rootCycles / low.rootCycles - 1,
          cyclesPerCounterCpuMsChangeFraction: high.cyclesPerCounterCpuMs / low.cyclesPerCounterCpuMs - 1,
          perPositionUserDeltaMs: high.evidence.map((e, i) => e.userMs - low.evidence[i].userMs) },
        descriptiveStrataNotAnAcceptanceGate: [...new Set(compatible.map(p => p.rootMinor))].sort((a,b)=>a-b).map(minor => ({ minor,
          evidenceUserMs: distribution(compatible.filter(p => p.rootMinor === minor).map(p => p.evidenceUserMs)) })),
        calibrationStable: checkpoint.calibrationStable,
      };
    });
  });
  const compatible = blocks.flatMap(b => b.points.filter(p => !p.rejectedBy.length));
  return { kind: 'E3-sealed-F0-offline-accounting-not-cause-or-requalification', blocks,
    totals: { blocks: blocks.length, points: blocks.reduce((n,b)=>n+b.points.length,0), compatible: compatible.length,
      rejectedWarm: blocks.flatMap(b=>b.points.slice(1)).filter(p=>p.rejectedBy.length).length,
      overRangeBlocks: blocks.filter(b=>b.original.compatibleRange>15).length,
      strataStillOver15ms: blocks.flatMap(b=>b.descriptiveStrataNotAnAcceptanceGate.filter(s=>s.evidenceUserMs.range>15).map(s=>({target:b.target,role:b.role,...s}))),
      metadataCpuMs: distribution(compatible.map(p=>p.metadataCpuMs)), efficiencyCpuMs: distribution(compatible.map(p=>p.efficiencyCpuMs)),
      betweenRootGapMs: distribution(blocks.flatMap(b=>b.points.slice(1).map(p=>p.gapAfterPreviousRootMs))) },
    limits: ['Whole-root counters cannot localize Evidence instructions or name the source of execution-rate changes.',
      'GC overlap is wall time, not measured GC thread-user CPU; absence of an observer event does not prove no GC.',
      'Post-hoc strata describe the retained failure; they do not modify the original 15ms gate or erase points.'] };
}
