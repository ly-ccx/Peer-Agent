import test from 'node:test';
import assert from 'node:assert/strict';
import {calibrationPlacementPlan, calibrationPlacementBudgetModel, calibrationPlacementReserve} from './e3-calibration-placement-plan.mjs';

test('placement changes neither full read work nor hash work; only B target uses fixed existing wait windows', () => {
  const p = calibrationPlacementPlan(); assert.deepEqual(p.targets.map(t => t.order), ['ABBA', 'BAAB']);
  for (const t of p.targets) for (const c of t.cells) {
    const [target, conditioning] = c.blocks;
    assert.deepEqual(c.blocks.map(b => b.role), ['target', 'conditioning']);
    assert.deepEqual(target.reads, conditioning.reads); assert.ok(target.reads.every(r => r.waitBeforeMs === 150));
    assert.equal(target.hashCalls, 3); assert.equal(conditioning.hashCalls, 3);
    assert.deepEqual(target.hashBeforeReadIndices, c.arm === 'B' ? [2, 5, 8] : []);
    assert.deepEqual(conditioning.hashBeforeReadIndices, []); assert.equal(conditioning.hashRemainderAfterLastRead, 3);
  }
  assert.equal(p.rootCount, 184); assert.equal(p.blockCount, 16); assert.equal(p.metricRoots, 128);
  assert.equal(p.totalHashCalls, 57); assert.equal(p.commonNativeCalls, 9); assert.equal(p.requestedWaitWindowsMs, 24000);
  assert.equal(p.f0AdmissionIssued, false); assert.equal(p.fieldWindowAllowed, false);
  assert.equal(p.warmFailuresPreservedAndFixedCellsStillCollected, true);
});
test('full model includes all nine common initialization calls and conservative overlap reservation', () => {
  const b = calibrationPlacementBudgetModel(); assert.equal(b.readForecastMs, 146250);
  assert.equal(b.hashForecastMs, 2850); assert.equal(b.wallForecastMs, 454250);
  assert.equal(b.totalWallForecastMs, 574250); assert.equal(b.totalActiveWallCapMs, 1020000);
  assert.equal(b.readHeadroomMs, 53750); assert.equal(b.hashHeadroomMs, 1150);
});
const completedHosts = Array.from({length: 2}, () => ({points: Array.from({length: 8}, () =>
  ({row: {userMs: 400, systemMs: 30, start: 0, end: 431}}))})),
  completedHashes = Array.from({length: 6}, () => ({userMs: 22, systemMs: 0}));
test('first entry reserves the unopened target too; both entries reject a one-microsecond shortage without resetting prior costs', () => {
  for (const [targetsRemaining, exact, roots, hashCalls] of [
    [2, {readCpuMs: 129750, hashCpuMs: 2550, wallMs: 390750, controllerCpuMs: 5000}, 168, 51],
    [1, {readCpuMs: 61500, hashCpuMs: 1200, wallMs: 241500, controllerCpuMs: 5000}, 80, 24]]) {
    const r = calibrationPlacementReserve({completedHosts, completedHashes, targetsRemaining, remaining: exact});
    assert.equal(r.admitted, true); assert.equal(r.roots, roots); assert.equal(r.hashCalls, hashCalls);
    assert.equal(r.readCpuMs, exact.readCpuMs); assert.equal(r.wallMs, exact.wallMs);
    for (const k of Object.keys(exact)) assert.equal(calibrationPlacementReserve({completedHosts, completedHashes, targetsRemaining,
      remaining: {...exact, [k]: exact[k] - .001}}).admitted, false);
  }
});
test('forecast uses every completed warmed root, including incompatible/slow ones, and rejects unknown preparation', () => {
  const hosts = structuredClone(completedHosts); hosts[0].points[6].row.userMs = 700;
  const r = calibrationPlacementReserve({completedHosts: hosts, completedHashes, targetsRemaining: 2,
    remaining: {readCpuMs: 200000, hashCpuMs: 4000, wallMs: 900000, controllerCpuMs: 20000}});
  assert.equal(r.warmMs, 1095); assert.equal(r.readCpuMs, 187365);
  const bad = structuredClone(completedHashes); bad[0].userMs = NaN;
  assert.throws(() => calibrationPlacementReserve({completedHosts, completedHashes: bad, targetsRemaining: 2, remaining: {}}), /cost_unknown/);
  assert.throws(() => calibrationPlacementReserve({completedHosts, completedHashes, targetsRemaining: 3, remaining: {}}), /preparation_required/);
});
