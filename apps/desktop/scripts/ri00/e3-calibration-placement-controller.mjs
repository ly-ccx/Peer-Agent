import {calibrationPlacementPlan} from './e3-calibration-placement-plan.mjs';
import {traceOrderBlock} from './e3-pair-order-controller.mjs';
import {evaluatePlacementTarget, evaluatePlacementCampaign} from './e3-calibration-placement-result.mjs';

/** The SHA work consumes the existing wait window. It never starts a second 150ms delay. */
export async function executePlacementBlock({read, calibrate, guard, now = () => performance.now(),
  wait = ms => new Promise(r => setTimeout(r, ms))}, spec, label) {
  const b = {label, role: spec.role, arm: spec.arm, points: [], markers: [], sequence: [], calibration: [], waits: [], hashPositions: []};
  async function native(beforeReadIndex) {
    guard(); const value = await calibrate({beforeReadIndex});
    b.calibration.push(value); b.hashPositions.push({beforeReadIndex, value}); guard();
  }
  for (let i = 0; i < spec.reads.length; i++) {
    guard(); const start = now(), action = spec.reads[i];
    if (spec.hashBeforeReadIndices.includes(i)) await native(i);
    while (now() - start < action.waitBeforeMs) await wait(Math.max(1, action.waitBeforeMs - (now() - start)));
    b.waits.push({beforeReadIndex: i, scheduledMs: action.waitBeforeMs, actualMs: now() - start});
    const p = await read(action.kind, 'cadence-root'); b.sequence.push(p);
    (action.kind === 'dense' ? b.points : b.markers).push(p); guard();
  }
  for (let i = 0; i < spec.hashRemainderAfterLastRead; i++) await native(null);
  return b;
}
export async function executePlacementCell({io, host, conditioning, spec, label}) {
  const executed = [];
  for (const block of spec.blocks) executed.push(await io.block(block.role === 'target' ? host : conditioning,
    block, `${label}-${block.role}`));
  return {arm: spec.arm, executed, targetBlock: executed[0], conditioningBlock: executed[1]};
}
export {traceOrderBlock};
export async function runPlacementCampaign({io, expected, report}) {
  const plan = calibrationPlacementPlan(), conditioning = await io.open('calibration-conditioning');
  await io.initialize(conditioning, 3); await io.warm(conditioning, 8);
  for (let ti = 0; ti < plan.targets.length; ti++) {
    const spec = plan.targets[ti], host = await io.open(spec.label), t = {label: spec.label, order: spec.order, cells: []};
    report.targets.push(t); await io.initialize(host, 3); await io.warm(host, 8);
    t.reservation = await io.reserve({targetsRemaining: 2 - ti});
    for (let i = 0; i < 4; i++) {
      await io.identity();
      t.cells.push(await executePlacementCell({io, host, conditioning, spec: spec.cells[i], label: `${spec.label}-cell-${i}`}));
      await io.checkpoint(t);
    }
    t.initialCalibration = {target: host.record.initialCalibration, conditioning: conditioning.record.initialCalibration};
    t.result = evaluatePlacementTarget(t, expected); await io.checkpoint(t); await io.close(host);
  }
  await io.close(conditioning); report.executionCompleted = true;
  Object.assign(report, evaluatePlacementCampaign(report.targets)); return report;
}
