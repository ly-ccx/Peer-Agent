import test from 'node:test';
import assert from 'node:assert/strict';
import {auditWarmBlock, joinControlledJournal} from './e3-cadence-variation.mjs';

function block() {
  return {label: 'F0', points: [9999, 120, 100, 110, 105, 1000, 2000, 115].map((n, i) => {
    const row = {ticketId: i + 1, label: 'cadence-root', start: i * 20000, end: i * 20000 + n + 130,
      userMs: n + 100, systemMs: 30, processUserMs: n + 100 + (i === 5 ? 120 : 0), processSystemMs: 30,
      instrumentationCpuMs: 1, heapBefore: {spaces: [{space_name: 'new_space', space_size: 67108864}]},
      heapAfter: {spaces: [{space_name: 'new_space', space_size: 67108864}]},
      gc: {minor: n === 100 ? 11 : 12, major: i === 6 ? 1 : 0, incremental: 0, observedOverlapMs: 3},
      evidence: Array.from({length: 12}, (_, k) => ({userMs: k === 0 ? (n === 120 ? 25 : 10) : k === 1 ? n - (n === 120 ? 25 : 10) : 0,
        systemMs: k === 0 && n === 120 ? .5 : k === 0 ? 1 : 0,
        gc: {minor: n === 100 && k === 0 ? 0 : 1, major: 0, incremental: 0, observedOverlapMs: .2}}))};
    return {row, pmc: {available: true, exclusiveWindow: true, cpuMs: n + 131, outsideMeasuredCpuMs: 1,
      levels: [{name: 'Performance', instructions: String(8e9 - n * 1000), cycles: '1600000000', cpuMs: n + 131},
        {name: 'Efficiency', instructions: '0', cycles: '0', cpuMs: 0}]}};
  })};
}
test('original first-point and strict 120ms exclusion stay unchanged; CPU extremes are not reordered into a fake temporal slowdown', () => {
  const a = auditWarmBlock(block());
  assert.equal(a.summary.compatible, 5); assert.equal(a.delta.evidenceUserMs, 20);
  assert.equal(a.before.ticketId, 3); assert.equal(a.after.ticketId, 2);
  assert.equal(a.chronology.highOccursLater, false); assert.equal(a.chronology.signedChronologicalUserDeltaMs, -20);
  assert.equal(a.groups.entered.userMs, 15); assert.equal(a.groups.retained.userMs, 5);
  assert.equal(a.delta.evidenceSystemMs, -.5); assert.equal(a.delta.evidenceTotalMs, 19.5);
  assert.ok(a.rootWork.instructionRelative < 0); assert.ok(a.rootWork.cpuPerCycleRelative > 0);
  assert.ok(Math.abs(a.rootWork.accounting.reconciliationErrorMs) < 1e-8);
  assert.equal(a.perLevelWork[1].accounting.available, false);
  assert.ok(a.sameSignatureChronologicalPairs.every(p => p.beforeTicket < p.afterTicket));
});
test('the journal accepts the explicit 84-root scope, preserves identical labels across hosts, and refuses wrong counts or duplicates', () => {
  const hosts = ['target', 'conditioning'].map(label => ({label, points: Array.from({length: 42}, (_, i) =>
    ({row: {label: 'cadence-root', ticketId: i + 1, hostMarker: label}}))})), report = {hosts},
    records = hosts.flatMap(h => h.points.map(p => ({kind: 'read-and-entry-batch', value: {host: h.label, value: {
      id: p.row.ticketId, batch: {rows: [p.row], gc: []}, before: {values: {ri_proc_start_abstime: '1'}},
      after: {values: {ri_proc_start_abstime: '1'}}}}})));
  const j = joinControlledJournal(report, records, 84);
  assert.equal(j.point('target', hosts[0].points[0]).row.hostMarker, 'target');
  assert.equal(j.point('conditioning', hosts[1].points[0]).row.hostMarker, 'conditioning');
  assert.throws(() => joinControlledJournal(report, records, 244));
  assert.throws(() => joinControlledJournal(report, [...records, records[0]], 84), /duplicate/);
});
test('missing outer PMC is not replaced by zero instruction work', () => {
  const b = block(); b.points[1].pmc.available = false;
  assert.throws(() => auditWarmBlock(b), /pmc_required/);
});
