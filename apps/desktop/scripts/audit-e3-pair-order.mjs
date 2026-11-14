import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {pairOrderPlan} from './ri00/e3-pair-order-plan.mjs';
import {orderBlockStatistics, evaluatePairOrderTarget, evaluatePairOrderCampaign} from './ri00/e3-pair-order-result.mjs';
import {cadenceBlockGaps, cadenceReadMetrics} from './ri00/e3-cadence-result.mjs';
import {evaluateE3Checkpoint, qualifiedE3Fast} from './ri00/e3-checkpoint.mjs';
import {browserMainCounterDelta} from './ri00/thread-counter-delta.mjs';
const args = process.argv.slice(2), opt = k => args[args.indexOf('--' + k) + 1];
for (const k of ['report', 'journal', 'binding', 'ready', 'budget', 'output'])
  if (!args.includes('--' + k)) throw Error('order_audit_inputs');
const hash = b => createHash('sha256').update(b).digest('hex'), raw = fs.readFileSync(opt('report')),
  r = JSON.parse(raw), read = k => JSON.parse(fs.readFileSync(opt(k))), binding = read('binding'), ready = read('ready'),
  budget = read('budget'), journalRaw = fs.readFileSync(opt('journal')),
  records = journalRaw.toString().trim().split('\n').map(JSON.parse), byTicket = new Map(), sum = a => a.reduce((s, x) => s + x, 0),
  near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `order_audit_reconciliation: ${a} != ${b}`),
  componentFields = ['evidenceUserMs', 'evidenceSystemMs', 'evidenceTotalCpuMs', 'rootUserMs', 'rootSystemMs',
    'rootTotalCpuMs', 'remainderUserMs', 'remainderSystemMs', 'instructions', 'cycles'];
assert.equal(r.kind, 'ORDER-fixed-three-host-complete-block-ABBA-BAAB-no-profiler-not-field-cause');
assert.equal(r.inputs.binding, hash(fs.readFileSync(opt('binding')))); assert.equal(r.inputs.ready, hash(fs.readFileSync(opt('ready'))));
assert.equal(r.inputs.budget, hash(fs.readFileSync(opt('budget')))); assert.equal(r.candidate, binding.candidate);
assert.equal(ready.candidate, r.candidate); assert.equal(ready.passed, true); assert.deepEqual(r.source, binding.source);
assert.equal(r.ownedLaunches, 3); assert.equal(r.executionCompleted, true); assert.equal(r.profileStarts, 0);
assert.equal(r.unknownCostGap, false); assert.deepEqual(r.failures, []); assert.equal(r.sourceUnchanged, true);
assert.equal(r.driverUnchanged, true); assert.deepEqual(r.initialCopy, r.finalCopy);
for (let i = 0; i < records.length; i++) {
  const record = records[i]; assert.equal(record.seq, i + 1);
  if (record.kind !== 'read-and-entry-batch') continue;
  const {host, value} = record.value, key = `${host}/${value.id}`;
  assert.ok(!byTicket.has(key)); assert.equal(value.batch.rows.length, 1); assert.equal(value.batch.rows[0].ticketId, value.id);
  byTicket.set(key, value);
}
const allMetrics = [];
for (const host of r.hosts) for (const p of host.points) {
  const original = byTicket.get(`${host.label}/${p.row.ticketId}`); assert.ok(original);
  assert.deepEqual(original.batch.rows[0], p.row);
  assert.equal(original.before.values.ri_proc_start_abstime, host.birth);
  assert.equal(original.after.values.ri_proc_start_abstime, host.birth);
  assert.deepEqual(browserMainCounterDelta(original.before, original.after, r.counterRuntime.timebase,
    p.row.userMs + p.row.systemMs), p.pmc);
  const m = cadenceReadMetrics(p); assert.deepEqual(m, p.metrics);
  near(m.evidenceUserMs + m.evidenceSystemMs, m.evidenceTotalCpuMs);
  near(m.evidenceTotalCpuMs + m.remainderUserMs + m.remainderSystemMs, m.rootTotalCpuMs);
  assert.ok(m.instructions > 0 && m.cycles > 0 && p.pmc.exclusiveWindow); allMetrics.push(m);
  assert.equal(p.row.origin, 'controlled'); assert.equal(p.row.sourceBefore, p.row.sourceAfter);
  assert.equal(p.row.outputSha256, binding.expected.outputSha256); assert.equal(p.row.rows, binding.expected.sessions);
  assert.equal(p.row.planCalls, binding.expected.planCalls); assert.equal(p.row.evidence.length, 12);
  assert.ok(p.row.evidence.every(e => e.rows === binding.expected.evidenceRows));
}
function auditBlock(block) {
  const b = block.controllerBoundary, start = records[b.startJournalSeq - 1], end = records[b.endJournalSeq - 1];
  assert.equal(start.kind, 'complete-block-start'); assert.equal(end.kind, 'complete-block-end');
  assert.equal(start.value.host, b.host); assert.equal(end.value.host, b.host);
  assert.equal(start.value.label, block.label); assert.equal(end.value.label, block.label);
  assert.equal(start.value.role, block.role); assert.equal(end.value.role, block.role);
  assert.equal(start.value.startedAtMs, b.startedAtMs); assert.equal(end.value.finishedAtMs, b.finishedAtMs);
  assert.ok(b.startedAtMs <= b.finishedAtMs && b.startJournalSeq < b.endJournalSeq);
  const interior = records.slice(b.startJournalSeq, b.endJournalSeq - 1), rows = interior.filter(r => r.kind === 'read-and-entry-batch'),
    calibration = interior.filter(r => r.kind === 'hash-calibration');
  assert.equal(rows.length, 10); assert.equal(calibration.length, 3); assert.equal(end.value.hashCalls, 3);
  assert.deepEqual(end.value.tickets, block.sequence.map(p => p.row.ticketId));
  assert.deepEqual(rows.map(r => r.value.value.id), end.value.tickets);
  assert.ok(rows.every(r => r.value.host === b.host && r.value.stage === block.label));
  assert.ok(calibration.every(r => r.value.host === b.host && r.value.stage === block.label));
  assert.ok(calibration[0].seq > rows.at(-1).seq); assert.deepEqual(calibration.map(c => c.value.value), block.calibration);
  for (const p of block.sequence) assert.deepEqual(p.row, byTicket.get(`${b.host}/${p.row.ticketId}`).batch.rows[0]);
  return {label: block.label, role: block.role, arm: block.arm, controllerBoundary: b,
    actualGaps: cadenceBlockGaps(block), statistics: orderBlockStatistics(block),
    originalReadAndHashCountsVerifiedAgainstJournal: true};
}
const targets = r.targets.map(t => {
  const f0 = evaluateE3Checkpoint({}, {identity: t.f0.gate.identity, mainA: t.f0Blocks[0], reference: t.f0Blocks[1],
    mainB: t.f0Blocks[2], sourceStable: r.sourceUnchanged, expected: binding.expected});
  assert.deepEqual(f0, t.f0); assert.deepEqual(t.f0Blocks.map(b => b.role), ['target', 'conditioning', 'target']);
  const blocks = t.f0Blocks.map(auditBlock);
  for (let i = 1; i < blocks.length; i++) {
    assert.ok(blocks[i - 1].controllerBoundary.endJournalSeq < blocks[i].controllerBoundary.startJournalSeq);
    assert.ok(blocks[i - 1].controllerBoundary.finishedAtMs <= blocks[i].controllerBoundary.startedAtMs);
  }
  assert.equal(qualifiedE3Fast(f0), t.cells.length === 4);
  if (!t.cells.length) assert.deepEqual(t.result, {controlsQualified: false, reason: 'original-F0-fast-bracket-rejected'});
  else assert.deepEqual(evaluatePairOrderTarget(t.cells, t.order), t.result);
  const reference = blocks[1].statistics.joint, normalized = [0, 2].map(i => ({targetBlock: blocks[i].label,
    components: Object.fromEntries(componentFields.map(k => [k, Number.isFinite(blocks[i].statistics.joint?.[k]) &&
      Number.isFinite(reference?.[k]) ? blocks[i].statistics.joint[k] - reference[k] : null])),
    descriptiveOnly: true, notReplacementForOriginalF0Deltas: true}));
  return {label: t.label, order: t.order, f0, f0Blocks: blocks, f0DescriptiveNormalization: normalized,
    cellsExecuted: t.cells.length, treatmentBlocks: t.cells.flatMap(c => c.executed.map(auditBlock)), result: t.result};
});
const expectedRoots = 24 + 60 + sum(targets.map(t => t.cellsExecuted * 20)), expectedBlocks = 6 + sum(targets.map(t => t.cellsExecuted * 2)),
  expectedHashCalls = expectedBlocks * 3;
assert.equal(allMetrics.length, expectedRoots); assert.equal(byTicket.size, expectedRoots); assert.equal(r.supervisorRoots, expectedRoots);
assert.equal(records.filter(r => r.kind === 'complete-block-start').length, expectedBlocks);
assert.equal(records.filter(r => r.kind === 'complete-block-end').length, expectedBlocks);
assert.equal(records.filter(r => r.kind === 'hash-calibration').length, expectedHashCalls);
const campaign = evaluatePairOrderCampaign(r.targets);
for (const k of ['controlsQualified', 'orderSensitivitySupported', 'rawContrastsMs', 'fixedEffectCriterionPassed']) assert.deepEqual(r[k], campaign[k]);
const recovery = r.hosts.map(h => {
  const e = h.exit, s = e.stopped;
  assert.equal(h.closed.code, 0); assert.equal(h.closed.signal, null); assert.ok(Object.values(e.owners).every(Boolean));
  assert.equal(s.restored, true); assert.equal(s.bindingRestored, true); assert.equal(s.readQueue.ticket, null);
  for (const k of ['metadataErrors', 'dropped', 'gcDropped', 'ledgerOverflows', 'retainedRowBytes', 'activeDepth']) assert.equal(s[k], 0);
  assert.equal(e.guard.sourceWritesDenied, 0); assert.equal(e.readFailures, 0);
  assert.equal(e.postMeasurementAudit.rows, binding.expected.evidenceRows); assert.equal(e.postMeasurementAudit.sha256, binding.evidenceSemanticSha256);
  assert.ok(Object.keys(h.transport.wireCounts).every(k => !k.startsWith('Profiler.'))); assert.deepEqual(h.transport.deniedCounts, {});
  return {label: h.label, roots: h.points.length, controlledCpuMs: s.controlledCpuMs, recordedRootCpuMs: h.recordedCpuMs,
    auditCpuMs: e.postMeasurementAudit.cpuMs, nativeCpuMs: s.nativeCpuMs, probeCpuMs: s.probeCpuMs,
    closed: true, restored: true, semanticAuditMatched: true, transport: h.transport};
});
near(r.readCpuMs, sum(recovery.map(h => Math.max(h.controlledCpuMs, h.recordedRootCpuMs) + h.auditCpuMs)));
near(r.hashCpuMs, sum(recovery.map(h => h.nativeCpuMs)));
near(sum(allMetrics.map(p => p.rootTotalCpuMs)) + sum(recovery.map(h => h.auditCpuMs)), r.readCpuMs);
const allBlocks = targets.flatMap(t => [...t.f0Blocks, ...t.treatmentBlocks]), gaps = allBlocks.flatMap(b => b.actualGaps.gapsMs),
  treeBytes = dir => fs.readdirSync(dir, {withFileTypes: true}).reduce((s, e) => s + (e.isDirectory() ? treeBytes(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0),
  outputBytes = treeBytes(path.dirname(opt('report'))) + r.preparationOutputBytes;
assert.ok(gaps.every(g => g >= 150)); assert.ok(outputBytes <= budget.outputBytes);
assert.ok(r.readCpuMs <= budget.readCpuMs && r.hashCpuMs <= budget.hashCpuMs && r.wallMs <= budget.wallMs);
assert.ok(r.controllerAuxChargedMs <= budget.controllerAuxCpuMs + budget.preparationShutdownReserveMs);
assert.equal(r.counterExit.known, true);
const root = fileURLToPath(new URL('../../../', import.meta.url)), cpu = process.cpuUsage(),
  audit = {kind: 'ORDER-sealed-fixed-quota-actual-order-spacing-and-CPU-PMC-audit', originalProducer: r.candidate,
    analysisCandidate: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(),
    analyzerSha256: hash(fs.readFileSync(fileURLToPath(import.meta.url))), inputSha256: hash(raw), journalSha256: hash(journalRaw),
    bindingSha256: r.inputs.binding, readySha256: r.inputs.ready, budgetSha256: r.inputs.budget,
    counts: {ownedElectronHosts: 3, roots: expectedRoots, blocks: expectedBlocks, hashCalls: expectedHashCalls,
      metricRoots: expectedBlocks * 8, completeTreatmentCells: sum(targets.map(t => t.cellsExecuted)),
      primaryContrasts: r.rawContrastsMs.length, allExternalPmcsReproducedFromRawBoundaries: allMetrics.length},
    targets, campaign, actualWithinBlockGaps: {count: gaps.length, minimumMs: Math.min(...gaps), maximumMs: Math.max(...gaps),
      valuesMs: gaps, allAtLeast150ms: true, crossHostClocksNeverSubtracted: true},
    allRootAccounting: Object.fromEntries(componentFields.map(k => [k, sum(allMetrics.map(p => p[k]))])),
    recovery, cost: {readCpuMs: r.readCpuMs, hashCpuMs: r.hashCpuMs, wallMs: r.wallMs,
      controllerRuntimeCpuMs: r.controllerRuntimeCpuMs, counterCpuMs: r.counterExit.finalCpuMs,
      preparationCpuMs: r.boundPrepCpuMs, controllerAuxChargedMs: r.controllerAuxChargedMs,
      outputBytesIncludingRetainedPreparation: outputBytes, journalBytes: r.journalBytes},
    sourceCopy: r.finalCopy, offlineCpuThroughAuditMs: (cpu.user + cpu.system) / 1000,
    scope: {rawAndNormalizedAllCpuComponentsPreserved: true, originalGateReplayedUnchanged: true,
      noNewProductReads: true, noNewExperimentHosts: true, noProfiler: true, naturalFieldFormationCaptured: false,
      oldResidualMechanismReproduced: false, fieldWindowStarted: false, RI00Closed: false, refactorStarted: false}};
const fd = fs.openSync(opt('output'), 'wx', 0o600);
try {fs.writeFileSync(fd, JSON.stringify(audit)); fs.fdatasyncSync(fd);} finally {fs.closeSync(fd);}
console.log(JSON.stringify({passed: true, counts: audit.counts, controlsQualified: campaign.controlsQualified,
  firstF0: targets[0].f0.gate.status, secondF0: targets[1].f0.gate.status, cost: audit.cost}));
