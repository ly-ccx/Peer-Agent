import assert from 'node:assert/strict';
import test from 'node:test';
import { motionDurationMs, sendScrollProgress } from './conversationMotion.ts';

test('CSS seconds and milliseconds produce the same animation duration', () => {
  assert.equal(motionDurationMs('0.2s'), 200);
  assert.equal(motionDurationMs('200ms'), 200);
  assert.equal(motionDurationMs('0s'), 0);
  assert.equal(motionDurationMs(''), 200);
});

test('an early RAF timestamp cannot move the viewport backwards', () => {
  assert.equal(sendScrollProgress(96, 100, 200), 0);
  assert.equal(sendScrollProgress(100, 100, 200), 0);
  assert.equal(sendScrollProgress(200, 100, 200), 0.875);
  assert.equal(sendScrollProgress(350, 100, 200), 1);
  assert.equal(sendScrollProgress(100, 100, 0), 1);
});
