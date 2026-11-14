import test from 'node:test';
import assert from 'node:assert/strict';
import {compactOrderSeamCell} from './e3-pair-order-seam-record.mjs';
const block = (role, start) => ({role, label: role, controllerBoundary: {host: role, startJournalSeq: start, endJournalSeq: start + 1,
  startedAtMs: start, finishedAtMs: start + 1}, calibration: [{userMs: 1}, {userMs: 1}, {userMs: 1}],
  sequence: Array.from({length: 10}, (_, i) => ({row: {ticketId: i + 1, label: 'cadence-root', readKind: 'dense', start: i * 200, end: i * 200 + 50},
    record: {unnecessaryReportDuplicate: 'raw fact belongs only in journal'.repeat(10000)}}))});
test('seam receipt references all original tickets and boundaries without duplicating raw journal rows', () => {
  const a = block('target', 1), b = block('conditioning', 3), raw = {arm: 'A', executed: [a, b], targetBlock: a, conditioningBlock: b},
    result = compactOrderSeamCell(raw), text = JSON.stringify(result);
  assert.equal(result.blocks.length, 2); assert.equal(result.blocks.flatMap(b => b.tickets).length, 20);
  assert.equal(text.includes('unnecessaryReportDuplicate'), false); assert.ok(Buffer.byteLength(text) < 10000);
  assert.equal(result.blocks[0].controllerBoundary, a.controllerBoundary); assert.equal(result.blocks[0].actualGaps.minimumMs, 150);
  assert.ok(raw.targetBlock.sequence[0].record.unnecessaryReportDuplicate.length > 10000);
});
test('compact projection rejects wrong execution order instead of hiding it with the requested arm', () => {
  const a = block('conditioning', 1), b = block('target', 3);
  assert.throws(() => compactOrderSeamCell({arm: 'A', executed: [a, b]}), /boundaries_invalid/);
});
