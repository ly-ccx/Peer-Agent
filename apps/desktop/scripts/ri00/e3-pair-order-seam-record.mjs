import assert from 'node:assert/strict';
import {actualOrderValid} from './e3-pair-order-result.mjs';
import {cadenceBlockGaps} from './e3-cadence-result.mjs';

/** Journal is the sole raw-row owner. The qualification report references durable facts without copying record.batch.rows again. */
export function compactOrderSeamCell(cell) {
  assert.equal(actualOrderValid(cell), true, 'order_seam_original_boundaries_invalid');
  return {arm: cell.arm, actualOrderVerified: true, rawFactsInJournal: true,
    blocks: cell.executed.map(block => ({label: block.label, role: block.role, controllerBoundary: block.controllerBoundary,
      actualGaps: cadenceBlockGaps(block), tickets: block.sequence.map(p => ({ticketId: p.row.ticketId,
        remoteLabel: p.row.label, readKind: p.row.readKind})), calibration: block.calibration}))};
}
