import test from 'node:test';
import assert from 'node:assert/strict';
import {auditCadenceVariation} from './e3-cadence-variation.mjs';
import {summarizeDenseBlock} from './dense-residual.mjs';

function fixture() {
  const hosts = ['cadence-reference', 'cadence-target-1', 'cadence-target-2'].map(label => ({label, points: []}));
  const failures = new Set(['0/2/reference', '0/3/reference', '1/0/reference', '1/1/target', '1/2/reference', '1/3/target']);
  function point(host, n, i = 0) {
    const row = {ticketId: host.points.length + 1, label: 'cadence-root', start: i * 500, end: i * 500 + n + 130,
      userMs: n + 100, systemMs: 30, processUserMs: n + 100, processSystemMs: 30, instrumentationCpuMs: .5,
      heapBefore: {spaces: [{space_name: 'new_space', space_size: 67108864}]},
      heapAfter: {spaces: [{space_name: 'new_space', space_size: 67108864}]},
      gc: {minor: 11, major: 0, incremental: 0, observedOverlapMs: 2},
      evidence: Array.from({length: 12}, (_, k) => ({userMs: k === 0 ? n : 0, systemMs: .01,
        gc: {minor: 1, major: 0, incremental: 0, observedOverlapMs: .1}}))};
    const p = {row, pmc: {available: true, exclusiveWindow: true, cpuMs: n + 130.5, outsideMeasuredCpuMs: .5,
      levels: [{name: 'Performance', instructions: String(8e9 + i * 100), cycles: String(16e8 + i * 10), cpuMs: n + 130.5}]}};
    host.points.push(p); return p;
  }
  function block(host, label, base, failed) {
    const points = Array.from({length: 8}, (_, i) => point(host, base + (i === 0 ? 999 : i === 7 && failed ? 20 : i), i));
    return {label, arm: 'A', points};
  }
  const targets = ['ABBA', 'BAAB'].map((order, ti) => {
    const host = hosts[ti + 1], cells = [...order].map((arm, i) => {
      const targetBase = ti === 0 ? (i === 3 ? 97 : 100) : (i === 2 ? 103 : 100),
        referenceBase = ti === 0 ? (i === 3 ? 99.5 : 100) : (i === 2 ? 98.5 : 100),
        targetBlock = block(host, `${order}-${i}-target`, targetBase, failures.has(`${ti}/${i}/target`)),
        referenceBlock = block(hosts[0], `${order}-${i}-reference`, referenceBase, failures.has(`${ti}/${i}/reference`));
      return {arm, targetBlock, referenceBlock, pair: {summaries: [targetBlock, referenceBlock].map(b => summarizeDenseBlock(b.points.map(p => p.row)))}};
    });
    const A = cells.filter(c => c.arm === 'A'), delta = c => c.pair.summaries[0].median - c.pair.summaries[1].median;
    return {label: host.label, order, cells, result: {sameArm: [{arm: 'A', deltaMs: delta(A[1]) - delta(A[0])}]}};
  });
  while (hosts.reduce((n, h) => n + h.points.length, 0) < 244) point(hosts[0], 100);
  return {supervisorRoots: 244, ownedLaunches: 3, executionCompleted: true, controlsQualified: false, hosts, targets};
}

test('six original extremes and signed A-return vectors close; constant labels never select wrong anchors', () => {
  const a = auditCadenceVariation(fixture());
  assert.deepEqual(a.warm.map(w => w.delta.evidenceUserMs), [19, 19, 19, 19, 19, 19]);
  assert.deepEqual(a.returns.map(r => r.delta.evidenceUserMs), [-2.5, 4.5]);
  assert.equal(a.returns[0].anchors.targetBefore.scalar.evidenceUserMs, 104);
  assert.equal(a.returns[0].anchors.targetAfter.scalar.evidenceUserMs, 101);
  assert.ok(a.warm.every(w => w.before.ticketId !== w.after.ticketId));
  assert.ok(a.warm.every(w => w.perPassInstructionsAndStacksMissing));
});
test('even compatible medians keep the same joint anchors, excluding both the first point and incompatible GC', () => {
  const r = fixture(), b = r.targets[0].cells[0].targetBlock;
  b.points[7].row.gc.major = 1;
  r.targets[0].cells[0].pair.summaries[0] = summarizeDenseBlock(b.points.map(p => p.row));
  const delta = c => c.pair.summaries[0].median - c.pair.summaries[1].median;
  r.targets[0].result.sameArm[0].deltaMs = delta(r.targets[0].cells[3]) - delta(r.targets[0].cells[0]);
  const a = auditCadenceVariation(r), selected = a.returns[0].anchors.targetBefore;
  assert.equal(selected.scalar.evidenceUserMs, 103.5);
  assert.deepEqual(selected.anchors.map(a => a.weight), [.5, .5]);
  assert.equal(selected.anchors.length, 2);
});
test('user decline and kernel increase remain separate without substituting total CPU for the rejected gate', () => {
  const r = fixture();
  for (const p of r.targets[0].cells[3].targetBlock.points) {
    p.row.evidence[0].systemMs += 2.5; p.row.systemMs += 2.5; p.row.processSystemMs += 2.5;
  }
  const d = auditCadenceVariation(r).returns[0];
  assert.equal(d.delta.evidenceUserMs, -2.5);
  assert.ok(Math.abs(d.delta.evidenceSystemMs - 2.5) < 1e-10);
  assert.ok(Math.abs(d.delta.evidenceTotalMs) < 1e-10);
  assert.equal(d.originalUserGateChanged, false);
});
test('journal joins all 244 roots by host/ticket, preserving missing versus zero counters and rejecting duplicates', () => {
  const r = fixture(), records = r.hosts.flatMap(h => h.points.map(p => ({kind: 'read-and-entry-batch', value: {
    host: h.label, value: {id: p.row.ticketId, batch: {rows: [p.row], gc: []},
      before: {values: {ri_proc_start_abstime: '1', ri_pageins: '0', ri_diskio_bytesread: '0'}},
      after: {values: {ri_proc_start_abstime: '1', ri_pageins: '0', ri_diskio_bytesread: '0'}}}}})));
  assert.equal(auditCadenceVariation(r, records).processCounterCoverage.joinedRoots, 244);
  assert.equal(auditCadenceVariation(r).processCounterCoverage.unknownCounterRoots, 244);
  assert.equal(auditCadenceVariation(r, records).processCounterCoverage.unknownCounterRoots, 0);
  assert.throws(() => auditCadenceVariation(r, [...records, records[0]]), /duplicate/);
  assert.throws(() => auditCadenceVariation(r, records.slice(1)), /missing/);
});
test('unavailable counters and changed original summaries are rejected rather than repaired', () => {
  const r = fixture(); r.targets[0].cells[2].referenceBlock.points[2].pmc.available = false;
  assert.throws(() => auditCadenceVariation(r), /outer_pmc_required/);
  const s = fixture(); s.targets[0].cells[0].pair.summaries[0].median += 1;
  assert.throws(() => auditCadenceVariation(s));
});
