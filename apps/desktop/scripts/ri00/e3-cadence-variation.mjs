import assert from 'node:assert/strict';
import {summarizeDenseBlock} from './dense-residual.mjs';
import {decomposeWork} from './e3-work-decomposition.mjs';

const sum = values => values.reduce((n, x) => n + x, 0);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `cadence_reconciliation: ${a} != ${b}`);
const compatible = point => summarizeDenseBlock([point.row, point.row]).compatible === 1;
const signature = r => JSON.stringify([r.gc.minor, r.gc.major, r.gc.incremental,
  r.evidence.map(e => [e.gc.minor, e.gc.major, e.gc.incremental])]);
const scalarFields = ['rootUserMs', 'rootSystemMs', 'rootTotalMs', 'evidenceUserMs',
  'evidenceSystemMs', 'evidenceTotalMs', 'remainderUserMs', 'remainderSystemMs',
  'remainderTotalMs', 'outsideMeasuredCpuMs', 'instrumentationCpuMs', 'wallMs', 'otherProcessCpuMs'];
const heap = h => Object.fromEntries(['new_space', 'old_space', 'large_object_space'].map(name => {
  const s = h.spaces.find(s => s.space_name === name);
  return [name, s ? {size: s.space_size, used: s.space_used_size, available: s.space_available_size} : null];
}));
function work(point) {
  assert.ok(point.pmc?.available && point.pmc.exclusiveWindow, 'cadence_outer_pmc_required');
  return {instructions: sum(point.pmc.levels.map(l => Number(l.instructions))),
    cycles: sum(point.pmc.levels.map(l => Number(l.cycles))), cpuMs: point.pmc.cpuMs};
}
function gcContext(point) {
  if (!point.observedGcEvents) return null;
  const r = point.row, overlaps = (e, span) => Math.min(span.end, e.start + e.duration) > Math.max(span.start, e.start),
    rootEvents = point.observedGcEvents.filter(e => overlaps(e, r)),
    prior = point.observedGcEvents.filter(e => (e.kind === 4 || e.kind === 8) && e.start + e.duration <= r.start)
      .sort((a, b) => b.start + b.duration - a.start - a.duration)[0];
  const counts = Object.fromEntries([['minor', 1], ['major', 4], ['incremental', 8]].map(([name, kind]) =>
    [name, rootEvents.filter(e => e.kind === kind).length]));
  return {reconstructedRootCounts: counts,
    originalRootCountsAgree: Object.entries(counts).every(([k, n]) => r.gc[k] === n),
    minorEventsOnlyInRemainder: rootEvents.filter(e => e.kind === 1 && !r.evidence.some(span => overlaps(e, span))).length,
    minorEventsOverlappingEvidence: rootEvents.filter(e => e.kind === 1 && r.evidence.some(span => overlaps(e, span))).length,
    precedingMajorIncremental: prior ? {kind: prior.kind, endToRootStartMs: r.start - prior.start - prior.duration} : null,
    observedIntervalsNotGcCpuCostOrCompleteNativeHistory: true};
}
function snapshot(p) {
  const r = p.row, evidenceUserMs = sum(r.evidence.map(e => e.userMs)),
    evidenceSystemMs = sum(r.evidence.map(e => e.systemMs));
  const delta = key => {
    const a = p.record?.before?.values?.[key], b = p.record?.after?.values?.[key];
    if (a === undefined || b === undefined) return null;
    assert.ok(BigInt(b) >= BigInt(a), 'cadence_process_counter_reversed');
    return String(BigInt(b) - BigInt(a));
  };
  return {ticketId: r.ticketId, rootUserMs: r.userMs, rootSystemMs: r.systemMs,
    rootTotalMs: r.userMs + r.systemMs, evidenceUserMs, evidenceSystemMs,
    evidenceTotalMs: evidenceUserMs + evidenceSystemMs, remainderUserMs: r.userMs - evidenceUserMs,
    remainderSystemMs: r.systemMs - evidenceSystemMs,
    remainderTotalMs: r.userMs + r.systemMs - evidenceUserMs - evidenceSystemMs,
    outsideMeasuredCpuMs: p.pmc.outsideMeasuredCpuMs, instrumentationCpuMs: r.instrumentationCpuMs,
    wallMs: r.end - r.start, otherProcessCpuMs: r.processUserMs + r.processSystemMs - r.userMs - r.systemMs,
    observedGcContext: gcContext(p), outer: work(p), levels: p.pmc.levels, fullGcSignature: JSON.parse(signature(r)),
    heapBefore: heap(r.heapBefore), heapAfter: heap(r.heapAfter),
    diskReadBytes: delta('ri_diskio_bytesread'), pageins: delta('ri_pageins'),
    gcObservedWallMs: r.gc.observedOverlapMs,
    evidenceGcObservedWallMs: sum(r.evidence.map(e => e.gc.observedOverlapMs))};
}
const difference = (a, b) => Object.fromEntries(scalarFields.map(k => [k, b[k] - a[k]]));
function reconcile(d, positions) {
  near(d.evidenceUserMs, sum(positions.map(p => p.userMs)));
  near(d.evidenceSystemMs, sum(positions.map(p => p.systemMs)));
  near(d.evidenceTotalMs, d.evidenceUserMs + d.evidenceSystemMs);
  near(d.rootTotalMs, d.evidenceTotalMs + d.remainderTotalMs);
  near(d.rootUserMs, d.evidenceUserMs + d.remainderUserMs);
  near(d.rootSystemMs, d.evidenceSystemMs + d.remainderSystemMs);
}
function workDifference(a, b) {
  return {instructionDelta: b.instructions - a.instructions,
    instructionRelative: b.instructions / a.instructions - 1,
    cpiRelative: (b.cycles / b.instructions) / (a.cycles / a.instructions) - 1,
    cpuPerCycleRelative: (b.cpuMs / b.cycles) / (a.cpuMs / a.cycles) - 1,
    accounting: decomposeWork(a, b), notPhysicalFrequencyOrPerPassWork: true};
}
function extreme(block) {
  const points = block.points.slice(1).filter(compatible).map((p, i) => ({p, i,
    user: sum(p.row.evidence.map(e => e.userMs))})).sort((a, b) => a.user - b.user || a.i - b.i);
  assert.ok(points.length >= 3, 'cadence_original_compatible_count');
  const a = points[0].p, b = points.at(-1).p, before = snapshot(a), after = snapshot(b),
    delta = difference(before, after), positions = a.row.evidence.map((e, i) => {
      const f = b.row.evidence[i], group = !e.gc.minor && !f.gc.minor ? 'neither' :
        !e.gc.minor ? 'entered' : !f.gc.minor ? 'left' : e.gc.minor === f.gc.minor ? 'retained' : 'changed-positive-count';
      return {position: i, userMs: f.userMs - e.userMs, systemMs: f.systemMs - e.systemMs,
        totalMs: f.userMs + f.systemMs - e.userMs - e.systemMs,
        beforeMinor: e.gc.minor, afterMinor: f.gc.minor, group,
        gcObservedWallDeltaMs: f.gc.observedOverlapMs - e.gc.observedOverlapMs};
    });
  reconcile(delta, positions);
  const summary = summarizeDenseBlock(block.points.map(p => p.row));
  near(delta.evidenceUserMs, summary.compatibleRange);
  const groups = Object.fromEntries([...new Set(positions.map(p => p.group))].map(group => {
    const selected = positions.filter(p => p.group === group);
    return [group, {positions: selected.map(p => p.position), userMs: sum(selected.map(p => p.userMs)),
      systemMs: sum(selected.map(p => p.systemMs)), notGcCpuAttribution: true}];
  }));
  const buckets = new Map();
  for (const {p, user} of points) { const k = signature(p.row), bucket = buckets.get(k) || [];
    bucket.push({ticketId: p.row.ticketId, evidenceUserMs: user}); buckets.set(k, bucket); }
  return {block: block.label, summary, before, after, delta, positions, groups,
    sameFullGcSignature: signature(a.row) === signature(b.row), rootWork: workDifference(before.outer, after.outer),
    sameSignatureSubgroups: [...buckets].map(([gcSignature, v]) => ({gcSignature: JSON.parse(gcSignature),
      points: v, rangeMs: Math.max(...v.map(p => p.evidenceUserMs)) - Math.min(...v.map(p => p.evidenceUserMs))})),
    originalGateNotReplacedByConditionedRanges: true, perPassInstructionsAndStacksMissing: true};
}
function anchor(block) {
  const points = block.points.slice(1).filter(compatible).map((p, i) => ({p, i,
    user: sum(p.row.evidence.map(e => e.userMs))})).sort((a, b) => a.user - b.user || a.i - b.i);
  assert.ok(points.length >= 3, 'cadence_median_compatible_count');
  const selected = points.length % 2 ? [points[points.length >> 1].p] :
    [points[points.length / 2 - 1].p, points[points.length / 2].p];
  const average = fn => sum(selected.map(fn)) / selected.length;
  const scalar = Object.fromEntries(scalarFields.map(k => [k, average(p => snapshot(p)[k])]));
  const vector = Array.from({length: 12}, (_, i) => ({position: i,
    userMs: average(p => p.row.evidence[i].userMs), systemMs: average(p => p.row.evidence[i].systemMs)}));
  near(scalar.evidenceUserMs, summarizeDenseBlock(block.points.map(p => p.row)).median);
  return {block: block.label, scalar, vector,
    anchors: selected.map(p => ({ticketId: p.row.ticketId, weight: 1 / selected.length, snapshot: snapshot(p)})),
    outer: Object.fromEntries(['instructions', 'cycles', 'cpuMs'].map(k => [k, average(p => work(p)[k])])),
    weightedAnchorsAreNotSyntheticMatchedReads: true};
}
function drift(t) {
  const cells = t.cells.map((c, i) => ({...c, index: i})).filter(c => c.arm === 'A');
  assert.equal(cells.length, 2, 'cadence_two_original_A_cells');
  const [first, last] = cells, anchors = {targetBefore: anchor(first.targetBlock), targetAfter: anchor(last.targetBlock),
    referenceBefore: anchor(first.referenceBlock), referenceAfter: anchor(last.referenceBlock)},
    {targetBefore: ta, targetAfter: tb, referenceBefore: ra, referenceAfter: rb} = anchors,
    targetDelta = difference(ta.scalar, tb.scalar), referenceDelta = difference(ra.scalar, rb.scalar),
    delta = Object.fromEntries(scalarFields.map(k => [k, targetDelta[k] - referenceDelta[k]])),
    positions = ta.vector.map((p, i) => ({position: i,
      targetUserMs: tb.vector[i].userMs - p.userMs,
      referenceUserMs: rb.vector[i].userMs - ra.vector[i].userMs,
      userMs: tb.vector[i].userMs - p.userMs - rb.vector[i].userMs + ra.vector[i].userMs,
      targetSystemMs: tb.vector[i].systemMs - p.systemMs,
      referenceSystemMs: rb.vector[i].systemMs - ra.vector[i].systemMs,
      systemMs: tb.vector[i].systemMs - p.systemMs - rb.vector[i].systemMs + ra.vector[i].systemMs}));
  reconcile(delta, positions);
  near(delta.evidenceUserMs, t.result.sameArm.find(x => x.arm === 'A').deltaMs);
  return {order: t.order, firstCell: first.index, lastCell: last.index, anchors, targetDelta, referenceDelta, delta,
    positions, targetWork: workDifference(ta.outer, tb.outer), referenceWork: workDifference(ra.outer, rb.outer),
    originalUserGateChanged: false, referenceContributionMs: -referenceDelta.evidenceUserMs};
}
/** Only joins original acknowledged facts. Host + ticket identifies rows; remote label is deliberately constant. */
function attachCadenceJournal(report, records) {
  const index = new Map(), events = new Map();
  for (const j of records) {
    if (j.kind !== 'read-and-entry-batch') continue;
    const {host, value: v} = j.value, key = `${host}/${v.id}`;
    assert.ok(v.id !== null && !index.has(key), 'cadence_journal_duplicate_or_unknown_ticket');
    assert.equal(v.batch.rows.length, 1);
    assert.equal(v.batch.rows[0].ticketId, v.id);
    index.set(key, v);
    const list = events.get(host) || []; list.push(...v.batch.gc); events.set(host, list);
  }
  const joined = new Map();
  for (const h of report.hosts) for (const p of h.points) {
    const key = `${h.label}/${p.row.ticketId}`, v = index.get(key);
    assert.ok(v, 'cadence_journal_row_missing'); assert.deepEqual(v.batch.rows[0], p.row);
    assert.equal(v.before.values.ri_proc_start_abstime, v.after.values.ri_proc_start_abstime);
    joined.set(key, {...p, record: v, observedGcEvents: events.get(h.label)});
  }
  assert.equal(joined.size, 244); assert.equal(index.size, joined.size);
  return {point(host, p) {const v = joined.get(`${host}/${p.row.ticketId}`); assert.ok(v); return v;}, events};
}
export function auditCadenceVariation(report, journal = null) {
  assert.equal(report.supervisorRoots, 244); assert.equal(report.ownedLaunches, 3);
  assert.equal(report.executionCompleted, true); assert.equal(report.controlsQualified, false);
  assert.deepEqual(report.targets.map(t => t.order), ['ABBA', 'BAAB']);
  const join = journal ? attachCadenceJournal(report, journal) : null;
  assert.ok(report.targets.every(t => t.cells.length === 4 && t.cells.every(c => c.referenceBlock.arm === 'A')), 'cadence_original_reference_arm');
  const targets = report.targets.map(t => ({...t, cells: t.cells.map(c => ({...c,
    targetBlock: {...c.targetBlock, points: c.targetBlock.points.map(p => join ? join.point(t.label, p) : p)},
    referenceBlock: {...c.referenceBlock, points: c.referenceBlock.points.map(p => join ? join.point('cadence-reference', p) : p)}}))}));
  const warm = targets.flatMap(t => t.cells.flatMap((c, cell) => ['target', 'reference'].flatMap((role, i) => {
    const b = c[role + 'Block'], summary = summarizeDenseBlock(b.points.map(p => p.row));
    assert.deepEqual(summary, c.pair.summaries[i]);
    return summary.compatibleRange > 15 ? [{order: t.order, cell, arm: c.arm, role, ...extreme(b)}] : [];
  })));
  assert.equal(warm.length, 6, 'cadence_six_original_warm_failures');
  const returns = targets.map(drift);
  const allPoints = report.hosts.flatMap(h => h.points.map(p => join ? join.point(h.label, p) : p));
  const journalHistory = join ? [...join.events].map(([host, events]) => {
    const rows = report.hosts.find(h => h.label === host).points.map(p => p.row), keys = new Set();
    assert.ok(events.every(e => {const k = JSON.stringify(e); const ok = !keys.has(k); keys.add(k); return ok;}), 'cadence_duplicate_gc_event');
    const majorIncremental = events.filter(e => e.kind === 4 || e.kind === 8).map(e => ({...e,
      overlappingTickets: rows.filter(r => Math.min(r.end, e.start + e.duration) > Math.max(r.start, e.start)).map(r => r.ticketId)}));
    return {host, gcEvents: events.length, majorIncremental,
      firstObservedMs: events.length ? Math.min(...events.map(e => e.start)) : null,
      lastObservedMs: events.length ? Math.max(...events.map(e => e.start + e.duration)) : null,
      observerHistoryNotProofOfCompleteNativeGc: true};
  }) : null;
  assert.equal(allPoints.length, 244);
  const referenceCells = targets.flatMap(t => t.cells.map((c, cell) => ({order: t.order, cell,
    arm: c.arm, anchor: anchor(c.referenceBlock)})));
  const sameGcReferenceShifts = [];
  for (let i = 1; i < referenceCells.length; i++) {
    const a = referenceCells[i - 1], b = referenceCells[i], sigs = [...a.anchor.anchors, ...b.anchor.anchors]
      .map(p => JSON.stringify(p.snapshot.fullGcSignature));
    if (new Set(sigs).size === 1) sameGcReferenceShifts.push({before: {order: a.order, cell: a.cell},
      after: {order: b.order, cell: b.cell}, delta: difference(a.anchor.scalar, b.anchor.scalar),
      work: workDifference(a.anchor.outer, b.anchor.outer), bothAlwaysAReference: true, notIndependentOrCause: true});
  }
  return {kind: 'CAD-sealed-six-warm-failures-and-two-A-return-decomposition-not-cause', warm, returns,
    sameGcReferenceShifts, journalHistory, counts: {allSupervisorRoots: allPoints.length,
      metricRoots: sum(report.targets.map(t => sum((t.f0Blocks || []).map(b => b.points.length)) +
        sum(t.cells.flatMap(c => [c.targetBlock.points.length, c.referenceBlock.points.length])))), failedWarmBlocks: warm.length, failedAReturns: returns.length},
    processCounterCoverage: {joinedRoots: join ? allPoints.length : 0,
      reconstructedRootGcMismatches: join ? allPoints.filter(p => !gcContext(p).originalRootCountsAgree).length : null,
      unknownCounterRoots: allPoints.filter(p => snapshot(p).diskReadBytes === null || snapshot(p).pageins === null).length,
      rootsWithDiskRead: allPoints.filter(p => Number(snapshot(p).diskReadBytes) > 0).length,
      rootsWithPageins: allPoints.filter(p => Number(snapshot(p).pageins) > 0).length},
    missing: ['per-pass retired instructions and cycles', 'hot execution stacks',
      'complete native GC and allocation history', 'field same-process residual formation', 'mechanism reproduction'],
    noNewProductReads: true, originalFailedGatesUnchanged: true, noGcWallSubtraction: true, notResidualAttribution: true};
}
