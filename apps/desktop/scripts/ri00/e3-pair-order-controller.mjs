import {pairOrderPlan} from './e3-pair-order-plan.mjs';
import {evaluateE3Checkpoint, qualifiedE3Fast} from './e3-checkpoint.mjs';
import {evaluatePBlockPair} from './e3-p-result.mjs';
import {evaluatePairOrderTarget, evaluatePairOrderCampaign} from './e3-pair-order-result.mjs';

/** Both seam qualification and real execution use these durable, complete-block boundaries. */
export async function traceOrderBlock({journal, host, spec, label, run, now = () => performance.now()}) {
  const startedAtMs = now(), start = journal.append('complete-block-start', {host, label, role: spec.role, arm: spec.arm, startedAtMs});
  const block = await run(), finishedAtMs = now(), end = journal.append('complete-block-end', {
    host, label, role: spec.role, arm: spec.arm, finishedAtMs,
    tickets: block.sequence.map(p => p.row.ticketId), hashCalls: block.calibration.length});
  block.controllerBoundary = {host, startedAtMs, finishedAtMs, startJournalSeq: start.seq, endJournalSeq: end.seq};
  return block;
}
export async function executeOrderCell({io, host, conditioning, spec, label}) {
  const executed = [];
  for (const block of spec.blocks) executed.push(await io.block(block.role === 'target' ? host : conditioning,
    {...block, arm: spec.arm}, `${label}-${block.role}`));
  return {arm: spec.arm, executed, targetBlock: executed.find(b => b.role === 'target'),
    conditioningBlock: executed.find(b => b.role === 'conditioning')};
}
export async function runPairOrderCampaign({io, expected, identity, report}) {
  const plan = pairOrderPlan(), conditioning = await io.open('order-conditioning');
  await io.warm(conditioning, plan.conditioningWarmRoots);
  for (const spec of plan.targets) {
    const host = await io.open(spec.label), t = {label: spec.label, order: spec.order, f0Blocks: [], cells: []};
    report.targets.push(t); await io.warm(host, spec.warmRoots);
    for (let i = 0; i < spec.f0.length; i++) t.f0Blocks.push(await io.block(
      spec.f0[i].role === 'target' ? host : conditioning, {...spec.f0[i], arm: 'F0'}, `${spec.label}-F0-${i}`));
    t.f0 = evaluateE3Checkpoint({}, {identity, mainA: t.f0Blocks[0], reference: t.f0Blocks[1], mainB: t.f0Blocks[2],
      sourceStable: await io.identity(), expected});
    if (!qualifiedE3Fast(t.f0)) {
      t.result = {controlsQualified: false, reason: 'original-F0-fast-bracket-rejected'};
      await io.checkpoint(t); await io.close(host); continue;
    }
    t.reservation = await io.reserve(t.f0Blocks);
    for (let i = 0; i < 4; i++) {
      const cell = await executeOrderCell({io, host, conditioning, spec: spec.cells[i], label: `${spec.label}-cell-${i}`});
      cell.pair = evaluatePBlockPair(cell.targetBlock, cell.conditioningBlock, expected, t.f0.calibrationRatios[0]);
      cell.pair.checks.bothF0CalibrationAnchors = t.f0.calibrationRatios.every(base => Math.abs(cell.pair.calibrationRatio / base - 1) <= .10);
      cell.pair.passed = Object.values(cell.pair.checks).every(Boolean);
      t.cells.push(cell); await io.checkpoint(t);
    }
    t.result = evaluatePairOrderTarget(t.cells, spec.order); await io.checkpoint(t); await io.close(host);
  }
  await io.close(conditioning); report.executionCompleted = true;
  Object.assign(report, evaluatePairOrderCampaign(report.targets)); return report;
}
