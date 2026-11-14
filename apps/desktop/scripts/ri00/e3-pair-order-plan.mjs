import {pBlockSchedule} from './e3-p-reservation.mjs';

/** Pure prospective design. Only the order of the two complete blocks changes; both hosts always wait 150ms. */
export function pairOrderPlan() {
  const block = role => ({role, reads: pBlockSchedule(), hashCalls: 3, remoteLabel: 'cadence-root'});
  const targets = ['ABBA', 'BAAB'].map((order, i) => ({label: `order-target-${i + 1}`, order, warmRoots: 8,
    f0: [block('target'), block('conditioning'), block('target')],
    cells: [...order].map(arm => ({arm, blocks: arm === 'A' ?
      [block('target'), block('conditioning')] : [block('conditioning'), block('target')]}))}));
  const blocks = targets.flatMap(t => [...t.f0, ...t.cells.flatMap(c => c.blocks)]), warmRoots = 24;
  return {kind: 'paired-complete-block-order-design-only', factor: 'complete-paired-block-order',
    arms: {A: 'target-then-conditioning', B: 'conditioning-then-target'},
    conditioningIsNotAnUntreatedReference: true, primary: 'raw target compatible-warm Evidence user median',
    priorNormalizedDeltaRetainedAsOriginalControlOnly: true, targets, conditioningWarmRoots: 8,
    warmRoots, blockCount: blocks.length, rootCount: warmRoots + blocks.reduce((n, b) => n + b.reads.length, 0),
    hashCalls: blocks.reduce((n, b) => n + b.hashCalls, 0),
    explicitWaitMs: blocks.reduce((n, b) => n + b.reads.reduce((s, r) => s + r.waitBeforeMs, 0), 0),
    semanticAudits: 3, profileStarts: 0, noNewProductReads: true, executableRunnerImplemented: false};
}
export function pairOrderBudgetModel() {
  const p = pairOrderPlan(), readForecastMs = 3 * 3000 + (p.rootCount - 3) * 750 + 1500,
    hashForecastMs = p.hashCalls * 50,
    wallForecastMs = readForecastMs + p.explicitWaitMs + p.hashCalls * 2000 + 60000 + 20000 + 90000;
  return {rootCount: p.rootCount, coldRoots: 3, coldRootCpuMs: 3000, warmRootCpuMs: 750, semanticCpuMs: 1500,
    readForecastMs, hashForecastMs, wallForecastMs,
    readCpuCapMs: 200000, hashCpuCapMs: 4000, wallCapMs: 900000,
    readHeadroomMs: 200000 - readForecastMs, hashHeadroomMs: 4000 - hashForecastMs,
    wallHeadroomMs: 900000 - wallForecastMs, notFutureCostGuarantee: true};
}
/** Reserve every remaining cell, all 3 audits and cleanup before starting the first order treatment. */
export function pairOrderReserve(f0, remaining) {
  const roots = f0.flatMap(b => b.sequence || [...b.markers, ...b.points]), hashes = f0.flatMap(b => b.calibration);
  if (roots.length !== 30 || hashes.length !== 9) throw Error('order_complete_F0_required');
  const rootMs = roots.map(p => p.row.userMs + p.row.systemMs), rootWall = roots.map(p => p.row.end - p.row.start),
    hashMs = hashes.map(h => h.userMs + h.systemMs);
  if ([...rootMs, ...rootWall, ...hashMs].some(x => !Number.isFinite(x) || x <= 0)) throw Error('order_F0_cost_unknown');
  const perRootMs = Math.max(750, ...rootMs.map(x => x * 1.5)),
    perRootWallMs = Math.max(perRootMs, ...rootWall.map(x => x * 1.5)),
    readCpuMs = 80 * perRootMs + 1500, hashCpuMs = 24 * Math.max(50, ...hashMs.map(x => x * 1.5)),
    wallMs = 80 * perRootWallMs + 1500 + 12000 + 48000 + 20000 + 10000 + 90000;
  return {roots: 80, hashCalls: 24, perRootMs, perRootWallMs, readCpuMs, hashCpuMs, wallMs,
    remaining: {...remaining}, admitted: remaining.readCpuMs >= readCpuMs && remaining.hashCpuMs >= hashCpuMs &&
      remaining.wallMs >= wallMs && remaining.controllerCpuMs >= 5000, notFutureCostGuarantee: true};
}
