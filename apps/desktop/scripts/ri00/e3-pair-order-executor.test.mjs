import test from 'node:test';
import assert from 'node:assert/strict';
import {runPairOrderCampaign, traceOrderBlock} from './e3-pair-order-controller.mjs';
import {orderBlockStatistics, evaluatePairOrderTarget} from './e3-pair-order-result.mjs';
import {pairOrderReserve} from './e3-pair-order-plan.mjs';
const expected = {sessions: 23, planCalls: 3859, evidenceRows: 69266, outputSha256: 'output'};
function fixture({effect = 10, conditioningEffect = 0, f0Fail = [], failWarm = false, returnDrift = 0, gapB = 150} = {}) {
  let roots = 0, blocks = 0, seq = 0, clock = 0;
  const opened = [], closed = [], journal = [], counts = new Map();
  const append = (kind, value) => {const r = {seq: ++seq, kind, value}; journal.push(r); return r;};
  const io = {
    open: async label => {opened.push(label); return {label};}, close: async h => closed.push(h.label),
    warm: async (_h, n) => {roots += n;}, identity: async () => true, checkpoint: async () => {},
    reserve: async f0 => pairOrderReserve(f0, {readCpuMs: 200000, hashCpuMs: 4000, wallMs: 900000, controllerCpuMs: 20000}),
    block: async (h, spec, label) => traceOrderBlock({journal: {append}, host: h.label, spec, label, now: () => ++clock,
      run: async () => {
        blocks++;
        const delta = typeof effect === 'function' ? effect(h.label) : effect,
          n = 270 + (spec.arm === 'B' ? (spec.role === 'target' ? delta : conditioningEffect) : 0) +
            (label.startsWith('order-target-1-cell-3') ? returnDrift : 0), gap = spec.arm === 'B' ? gapB : 150;
        let rowClock = 0;
        const sequence = spec.reads.map((_, i) => {
          const ticketId = (counts.get(h.label) || 0) + 1; counts.set(h.label, ticketId);
          const user = n + (i === 1 ? 20 : i * .25), start = rowClock; rowClock += user + 130 + gap;
          const row = {label: 'cadence-root', ticketId,
            samplingSchema: 'controlled-heap-v1', readKind: 'dense', sourceBefore: 'same', sourceAfter: 'same',
            rows: 23, planCalls: 3859, outputSha256: 'output',
            start, end: start + user + 130,
            userMs: user + 100, systemMs: 30, processUserMs: user + 100, processSystemMs: 30,
            instrumentationCpuMs: 1, heapBefore: {spaces: [{space_name: 'new_space', space_size: 67108864}]},
            heapAfter: {spaces: [{space_name: 'new_space', space_size: 67108864}]},
            gc: {minor: 12, major: label.includes('-F0-') && f0Fail.includes(h.label) ? 1 : 0, incremental: 0},
            evidence: Array.from({length: 12}, (_, position) => ({userMs: position === 11 ? user - 11 * Math.floor(user / 12 * 4) / 4 : Math.floor(user / 12 * 4) / 4, systemMs: .1, rows: 69266,
              gc: {minor: 1, major: 0, incremental: 0}}))};
          return {row, pmc: {available: true, exclusiveWindow: true, cpuMs: user + 131,
            levels: [{name: 'Performance', instructions: '8000000000', cycles: '1700000000', cpuMs: user + 131}]}};
        }); roots += 10;
        const b = {label, role: spec.role, arm: spec.arm, sequence, markers: [sequence[0], sequence[9]], points: sequence.slice(1, 9),
          calibration: Array.from({length: 3}, () => ({userMs: 22, systemMs: 0}))};
        if (failWarm && label === 'order-target-1-cell-2-conditioning') b.points[7].row.evidence[0].userMs += 16;
        return b;
      }})
  };
  return {io, opened, closed, journal, get roots() {return roots;}, get blocks() {return blocks;}};
}
const run = f => runPairOrderCampaign({io: f.io, expected, identity: 'fixture', report: {targets: []}});
test('fixed three slots execute 244 equal-work roots and complete ABBA/BAAB with durable order boundaries', async () => {
  const f = fixture(), r = await run(f);
  assert.equal(f.roots, 244); assert.equal(f.blocks, 22); assert.equal(f.opened.length, 3); assert.equal(f.closed.length, 3);
  assert.equal(r.executionCompleted, true); assert.equal(r.controlsQualified, true); assert.equal(r.orderSensitivitySupported, true);
  assert.deepEqual(r.rawContrastsMs, [10, 10, 10, 10]);
  for (const t of r.targets) for (const c of t.cells) assert.deepEqual(c.executed.map(b => b.role),
    c.arm === 'A' ? ['target', 'conditioning'] : ['conditioning', 'target']);
  assert.equal(f.journal.filter(e => e.kind === 'complete-block-start').length, 22);
});
test('raw target endpoint is not cancelled by treating the conditioning host as an untreated reference', async () => {
  const r = await run(fixture({effect: 10, conditioningEffect: 9}));
  assert.equal(r.controlsQualified, true); assert.equal(r.orderSensitivitySupported, true);
  assert.equal(r.targets[0].result.contrasts[0].rawTarget.evidenceUserMs, 10);
  assert.equal(r.targets[0].result.contrasts[0].normalized.evidenceUserMs, 1);
});
test('both fixed F0 refusals remain consumed, without replacement or treatment reads', async () => {
  const f = fixture({f0Fail: ['order-target-1', 'order-target-2']}), r = await run(f);
  assert.equal(f.roots, 84); assert.equal(f.opened.length, 3); assert.ok(r.targets.every(t => t.cells.length === 0));
  assert.equal(r.controlsQualified, false); assert.equal(r.executionCompleted, true);
});
test('one F0 refusal still runs only the originally allocated other target', async () => {
  const f = fixture({f0Fail: ['order-target-1']}), r = await run(f);
  assert.equal(f.roots, 164); assert.equal(f.opened.length, 3); assert.equal(r.targets[1].cells.length, 4);
  assert.equal(r.orderSensitivitySupported, false);
});
test('valid zero effect and opposite cross-host signs fail the preregistered effect criterion', async () => {
  for (const options of [{effect: 0}, {effect: h => h === 'order-target-2' ? -10 : 10}]) {
    const r = await run(fixture(options)); assert.equal(r.controlsQualified, true); assert.equal(r.orderSensitivitySupported, false);
  }
});
test('ordinary warm rejection keeps all four return cells and does not resample', async () => {
  const f = fixture({failWarm: true}), r = await run(f);
  assert.equal(f.roots, 244); assert.equal(r.targets[0].cells.length, 4); assert.equal(r.controlsQualified, false);
  assert.equal(r.targets[0].result.checks.originalBlocks, false);
});
test('raw drift cannot hide behind a cancelling normalized return or total CPU', async () => {
  const r = await run(fixture({returnDrift: 2.1})), c = r.targets[0].result.checks;
  assert.equal(c.originalNormalizedReturn, true); assert.equal(c.rawTargetReturn, false); assert.equal(c.rawConditioningReturn, false);
  assert.equal(r.controlsQualified, false);
});
test('the actual gap and five-millisecond contrast checks remain hard controls', async () => {
  const short = await run(fixture({gapB: 149})); assert.equal(short.targets[0].result.checks.actualGaps, false);
  const shifted = await run(fixture({gapB: 156})); assert.equal(shifted.targets[0].result.checks.comparableTargetGaps, false);
});
test('swapped roles, overlapping controller times, missing hash and nonmonotonic journal boundaries cannot qualify', async () => {
  const r = await run(fixture());
  for (const mutate of [c => c.executed.reverse(), c => {c.executed[1].controllerBoundary.startedAtMs = 0;},
    c => c.executed[0].calibration.pop(), c => {c.executed[1].controllerBoundary.startJournalSeq = 1;}]) {
    const cells = structuredClone(r.targets[0].cells); mutate(cells[0]);
    assert.equal(evaluatePairOrderTarget(cells, 'ABBA').checks.actualOrder, false);
  }
});
test('median components use one joint odd/even anchor selection and exclude the retained first metric root', async () => {
  const r = await run(fixture()), b = r.targets[0].cells[0].targetBlock;
  b.points[7].row.gc.major = 1;
  const s = orderBlockStatistics(b); assert.equal(s.anchors.length, 2);
  assert.equal(s.joint.evidenceUserMs, s.summary.median); assert.ok(s.joint.evidenceUserMs < 280);
  assert.ok(Math.abs(s.joint.evidenceUserMs + s.joint.evidenceSystemMs - s.joint.evidenceTotalCpuMs) < 1e-9);
});
test('incomplete admission and unknown block outcome abort without another host or replay', async () => {
  const f = fixture(); f.io.reserve = async () => {throw Error('complete-return-not-reserved');};
  await assert.rejects(run(f), /not-reserved/); assert.equal(f.blocks, 3); assert.equal(f.opened.length, 2);
  let id = 0; const records = [], error = Error('unknown-block-outcome');
  await assert.rejects(traceOrderBlock({journal: {append: (kind, value) => {records.push({kind, value}); return {seq: ++id};}},
    host: 'owned', label: 'one-attempt', spec: {role: 'target', arm: 'A'}, run: async () => {throw error;}}), e => e === error);
  assert.equal(records.length, 1); assert.equal(records[0].kind, 'complete-block-start');
});
