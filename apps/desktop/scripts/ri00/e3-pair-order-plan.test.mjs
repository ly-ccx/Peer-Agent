import test from 'node:test';
import assert from 'node:assert/strict';
import {pairOrderPlan, pairOrderBudgetModel, pairOrderReserve} from './e3-pair-order-plan.mjs';

test('prospective order design changes only full paired block order, never per-host work, label or requested gaps', () => {
  const p = pairOrderPlan(); assert.deepEqual(p.targets.map(t => t.order), ['ABBA', 'BAAB']);
  for (const t of p.targets) for (const c of t.cells) {
    assert.deepEqual(c.blocks.map(b => b.role), c.arm === 'A' ? ['target', 'conditioning'] : ['conditioning', 'target']);
    const [a, b] = c.blocks; assert.deepEqual(a.reads, b.reads); assert.equal(a.hashCalls, b.hashCalls);
    assert.ok(c.blocks.every(b => b.remoteLabel === 'cadence-root' && b.reads.every(r => r.waitBeforeMs === 150)));
  }
  assert.ok(p.targets.every(t => t.f0.map(b => b.role).join('/') === 'target/conditioning/target'));
  assert.equal(p.conditioningIsNotAnUntreatedReference, true);
  assert.equal(p.executableRunnerImplemented, false);
});
test('full model retains 3 fixed hosts, 244 roots, 66 hashes and covers all 33 seconds requested waits', () => {
  const p = pairOrderPlan(), b = pairOrderBudgetModel();
  assert.equal(p.rootCount, 244); assert.equal(p.hashCalls, 66); assert.equal(p.blockCount, 22);
  assert.equal(p.explicitWaitMs, 33000); assert.equal(b.readForecastMs, 191250);
  assert.equal(b.hashForecastMs, 3300); assert.equal(b.wallForecastMs, 526250);
  assert.equal(b.readHeadroomMs, 8750); assert.equal(b.wallHeadroomMs, 373750);
});
test('complete order return reserve includes 12-second waits and rejects any one-microsecond shortage', () => {
  const f0 = Array.from({length: 3}, () => ({sequence: Array.from({length: 10}, () => ({row: {userMs: 400, systemMs: 30, start: 0, end: 431}})),
    calibration: Array.from({length: 3}, () => ({userMs: 22, systemMs: 0}))})),
    exact = {readCpuMs: 61500, hashCpuMs: 1200, wallMs: 241500, controllerCpuMs: 5000};
  const r = pairOrderReserve(f0, exact); assert.equal(r.admitted, true);
  assert.equal(pairOrderReserve(f0, {...exact, readCpuMs: 200000}).readCpuMs, 61500);
  assert.equal(pairOrderReserve(f0, {...exact, wallMs: 900000}).wallMs, 241500);
  for (const k of Object.keys(exact)) assert.equal(pairOrderReserve(f0, {...exact, [k]: exact[k] - .001}).admitted, false);
  assert.throws(() => pairOrderReserve(f0.slice(1), exact), /complete_F0/);
  const unknown = structuredClone(f0); unknown[0].sequence[0].row.userMs = NaN;
  assert.throws(() => pairOrderReserve(unknown, exact), /cost_unknown/);
});
