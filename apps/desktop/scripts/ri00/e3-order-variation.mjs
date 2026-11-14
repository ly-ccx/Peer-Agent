import assert from 'node:assert/strict';
import {auditWarmBlock, joinControlledJournal} from './e3-cadence-variation.mjs';
import {evaluateE3Checkpoint} from './e3-checkpoint.mjs';
import {cadenceReadMetrics} from './e3-cadence-result.mjs';
import {browserMainCounterDelta} from './thread-counter-delta.mjs';

/** Reuses the original warm statistic and work identity; never turns an extreme into a time-ordered transition. */
export function auditOrderF0Variation(report, records, expected) {
  assert.equal(report.kind, 'ORDER-fixed-three-host-complete-block-ABBA-BAAB-no-profiler-not-field-cause');
  assert.equal(report.supervisorRoots, 84); assert.equal(report.ownedLaunches, 3);
  assert.equal(report.executionCompleted, true); assert.equal(report.controlsQualified, false);
  assert.equal(report.profileStarts, 0); assert.equal(report.sourceUnchanged, true);
  assert.deepEqual(report.targets.map(t => t.order), ['ABBA', 'BAAB']);
  assert.ok(report.targets.every(t => t.cells.length === 0));
  const joined = joinControlledJournal(report, records, 84), blocks = [], rootMetrics = [];
  for (const t of report.targets) {
    assert.equal(t.f0Blocks.length, 3);
    assert.deepEqual(t.f0Blocks.map(b => b.role), ['target', 'conditioning', 'target']);
    const original = evaluateE3Checkpoint({}, {identity: t.f0.gate.identity, mainA: t.f0Blocks[0],
      reference: t.f0Blocks[1], mainB: t.f0Blocks[2], sourceStable: report.sourceUnchanged, expected});
    assert.deepEqual(original, t.f0); assert.equal(t.f0.gate.deltas, null);
    for (let i = 0; i < 3; i++) {
      const b = t.f0Blocks[i], host = b.role === 'target' ? t.label : 'order-conditioning',
        points = b.points.map(p => joined.point(host, p)), comparison = auditWarmBlock({...b, points});
      assert.deepEqual(comparison.summary, t.f0.gate.summaries[i]);
      assert.equal(b.calibration.length, 3);
      assert.ok(b.calibration.every(c => c.start >= b.sequence.at(-1).row.end));
      blocks.push({calibration: b.calibration, originalCalibrationAfterAllRoots: true, target: t.label, plannedOrder: t.order, F0Block: i, role: b.role, host,
        failedOriginalWarmGate: comparison.summary.compatibleRange > 15, ...comparison});
    }
  }
  for (const h of report.hosts) for (const p of h.points) {
    const original = joined.point(h.label, p), r = original.row, metrics = cadenceReadMetrics(p);
    assert.deepEqual(metrics, p.metrics);
    assert.deepEqual(browserMainCounterDelta(original.record.before, original.record.after, report.counterRuntime.timebase,
      r.userMs + r.systemMs), p.pmc);
    const processDelta = key => String(BigInt(original.record.after.values[key]) - BigInt(original.record.before.values[key]));
    rootMetrics.push({host: h.label, stage: p.controllerStage, ...metrics,
      processDiskReadBytes: processDelta('ri_diskio_bytesread'), processPageins: processDelta('ri_pageins')});
  }
  const failures = blocks.filter(b => b.failedOriginalWarmGate), controls = blocks.filter(b => !b.failedOriginalWarmGate);
  assert.equal(failures.length, 5); assert.equal(controls.length, 1);
  const histories = [...joined.events].map(([host, events]) => {
    const keys = new Set();
    for (const e of events) {const key = JSON.stringify(e); assert.ok(!keys.has(key)); keys.add(key);}
    const rows = report.hosts.find(h => h.label === host).points.map(p => p.row);
    return {host, events: events.length, majorIncremental: events.filter(e => e.kind === 4 || e.kind === 8).map(e => ({...e,
      overlappingTickets: rows.filter(r => Math.min(r.end, e.start + e.duration) > Math.max(r.start, e.start)).map(r => r.ticketId)})),
      observerIsNotCompleteNativeHistory: true};
  });
  return {kind: 'ORDER-84-root-five-F0-warm-range-work-and-rate-accounting-not-mechanism',
    counts: {supervisorRoots: rootMetrics.length, metricRoots: 48, warmBlocks: blocks.length,
      failedWarmBlocks: failures.length, targetFailures: failures.filter(b => b.role === 'target').length,
      conditioningFailures: failures.filter(b => b.role === 'conditioning').length,
      highEarlierThanLow: failures.filter(b => !b.chronology.highOccursLater).length,
      sameSignatureChronologicalPairs: blocks.reduce((n, b) => n + b.sameSignatureChronologicalPairs.length, 0)},
    failures, controls, rootMetrics, histories,
    interpretation: {original15msGateUnchanged: true, noGcWallSubtraction: true,
      noPerPassInstructionsOrNativeCpuImputed: true, noPhysicalFrequencyClaim: true,
      noQualifiedTemporalFormation: true, originalOrderTreatmentStillNotExecuted: true,
      noNewProductReads: true, RI00Closed: false, refactorStarted: false}};
}
