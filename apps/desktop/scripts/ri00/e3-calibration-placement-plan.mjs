import {pBlockSchedule} from './e3-p-reservation.mjs';

/** Diagnostic only: the original warm gate is an observed outcome, never a fast-admission token. */
export function calibrationPlacementPlan() {
  const block = (role, arm) => ({role, arm, reads: pBlockSchedule(), hashCalls: 3, remoteLabel: 'cadence-root',
    hashBeforeReadIndices: role === 'target' && arm === 'B' ? [2, 5, 8] : [],
    hashRemainderAfterLastRead: role === 'target' && arm === 'B' ? 0 : 3,
    hashConsumesExisting150msWaitWindow: true});
  const targets = ['ABBA', 'BAAB'].map((order, i) => ({label: `calibration-target-${i + 1}`, order, warmRoots: 8,
    commonNativeCallsBeforeWarmRoots: 3,
    cells: [...order].map(arm => ({arm, blocks: [block('target', arm), block('conditioning', arm)]}))}));
  const blocks = targets.flatMap(t => t.cells.flatMap(c => c.blocks)), warmRoots = 24;
  return {kind: 'calibration-placement-diagnostic-design-only',
    factor: {A: 'three-original-native-hash-calls-after-complete-read-block',
      B: 'same-three-native-hash-calls-in-existing-gaps-before-read-indices-2-5-8'},
    targets, conditioningWarmRoots: 8, conditioningCommonNativeCalls: 3, warmRoots,
    commonNativeCalls: 9, blockCount: blocks.length, rootCount: warmRoots + blocks.length * 10,
    blockHashCalls: blocks.length * 3, totalHashCalls: blocks.length * 3 + 9,
    requestedWaitWindowsMs: blocks.length * 10 * 150, warmRequestedExtraWaitMs: 0,
    metricRoots: blocks.length * 8, semanticAudits: 3, profileStarts: 0,
    diagnosticOnly: true, f0AdmissionIssued: false, fieldWindowAllowed: false,
    warmFailuresPreservedAndFixedCellsStillCollected: true,
    noNewProductReads: true, executableRunnerImplemented: false};
}
export function calibrationPlacementBudgetModel() {
  const p = calibrationPlacementPlan(), readForecastMs = 3 * 3000 + (p.rootCount - 3) * 750 + 1500,
    hashForecastMs = p.totalHashCalls * 50,
    wallForecastMs = readForecastMs + p.requestedWaitWindowsMs + p.totalHashCalls * 2000 + 60000 + 20000 + 90000;
  return {rootCount: p.rootCount, coldRoots: 3, coldRootCpuMs: 3000, warmRootCpuMs: 750,
    semanticCpuMs: 1500, readForecastMs, hashForecastMs, wallForecastMs,
    readCpuCapMs: 200000, hashCpuCapMs: 4000, wallCapMs: 900000,
    preparationWallReserveMs: 120000, totalActiveWallCapMs: 1020000,
    totalWallForecastMs: wallForecastMs + 120000, totalWallHeadroomMs: 1020000 - wallForecastMs - 120000,
    readHeadroomMs: 200000 - readForecastMs, hashHeadroomMs: 4000 - hashForecastMs,
    wallHeadroomMs: 900000 - wallForecastMs, overlappingNativeAndWaitWallConservativelyDoubleReserved: true,
    notFutureCostGuarantee: true};
}
/** First admission reserves both complete four-cell series AND the unopened target's startup/warm/init. */
export function calibrationPlacementReserve({completedHosts, completedHashes, targetsRemaining, remaining}) {
  if (![1, 2].includes(targetsRemaining) || completedHosts.length < 2 ||
    completedHosts.some(h => h.points.length < 8) || completedHashes.length < 6) throw Error('placement_completed_preparation_required');
  const cold = completedHosts.map(h => h.points[0].row), warm = completedHosts.flatMap(h => h.points.slice(1).map(p => p.row)),
    rootCpu = r => r.userMs + r.systemMs, rootWall = r => r.end - r.start, hashCpu = h => h.userMs + h.systemMs;
  if ([...cold, ...warm].some(r => !Number.isFinite(rootCpu(r)) || rootCpu(r) <= 0 ||
    !Number.isFinite(rootWall(r)) || rootWall(r) <= 0) || completedHashes.some(h => !Number.isFinite(hashCpu(h)) || hashCpu(h) <= 0))
    throw Error('placement_preparation_cost_unknown');
  const coldMs = Math.max(3000, ...cold.map(r => rootCpu(r) * 1.5)),
    warmMs = Math.max(750, ...warm.map(r => rootCpu(r) * 1.5)),
    coldWallMs = Math.max(coldMs, ...cold.map(r => rootWall(r) * 1.5)),
    warmWallMs = Math.max(warmMs, ...warm.map(r => rootWall(r) * 1.5)),
    futureHosts = targetsRemaining - 1, roots = targetsRemaining * 80 + futureHosts * 8,
    hashCalls = targetsRemaining * 24 + futureHosts * 3,
    readCpuMs = futureHosts * coldMs + (roots - futureHosts) * warmMs + 1500,
    readWallMs = futureHosts * coldWallMs + (roots - futureHosts) * warmWallMs + 1500,
    hashCpuMs = hashCalls * Math.max(50, ...completedHashes.map(h => hashCpu(h) * 1.5)),
    gapWindowsMs = targetsRemaining * 80 * 150, hashRpcWallMs = hashCalls * 2000,
    futureStartupMs = futureHosts * 15000,
    wallMs = readWallMs + gapWindowsMs + hashRpcWallMs + futureStartupMs + 20000 + 10000 + 90000;
  return {targetsRemaining, futureHosts, roots, hashCalls, coldMs, warmMs, coldWallMs, warmWallMs,
    readCpuMs, hashCpuMs, wallMs, gapWindowsMs, hashRpcWallMs, futureStartupMs,
    remaining: {...remaining}, admitted: remaining.readCpuMs >= readCpuMs && remaining.hashCpuMs >= hashCpuMs &&
      remaining.wallMs >= wallMs && remaining.controllerCpuMs >= 5000, notFutureCostGuarantee: true};
}
