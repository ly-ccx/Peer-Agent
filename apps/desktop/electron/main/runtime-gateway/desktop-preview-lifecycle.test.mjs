import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPreviewIdleWatch, createPreviewKeepAlive, PREVIEW_IDLE_MS, PREVIEW_KEEPALIVE_MS, previewSessionIsOpen } from './desktop-preview-lifecycle.mjs';

test('live connected child is open; dead or disconnected child is not', () => {
  assert.equal(previewSessionIsOpen({ child: { connected: true, exitCode: null, signalCode: null } }), true);
  assert.equal(previewSessionIsOpen({ child: { connected: true, exitCode: 0, signalCode: null } }), false);
  assert.equal(previewSessionIsOpen({ child: { connected: false, exitCode: null, signalCode: null } }), false);
  assert.equal(previewSessionIsOpen({ child: { connected: true, exitCode: null, signalCode: 'SIGTERM' } }), false);
  assert.equal(previewSessionIsOpen(null), false);
});

test('idle watch fires once, then observe/message resets the budget', () => {
  const fired = [];
  let tick = null;
  const watch = createPreviewIdleWatch(() => fired.push('exit'), {
    idleMs: 10,
    setTimer: (fn) => { tick = fn; return { unref() {} }; },
    clearTimer: () => { tick = null; },
  });
  assert.equal(typeof tick, 'function');
  watch.arm();
  tick();
  assert.deepEqual(fired, ['exit']);
  watch.arm();
  assert.equal(typeof tick, 'function');
  watch.disarm();
  assert.equal(tick, null);
});

test('parent keepalive ticks while a session is open and stops on close', () => {
  const sent = [];
  let tick = null;
  const keepalive = createPreviewKeepAlive(() => sent.push('ping'), {
    intervalMs: 1,
    setTimer: (fn) => { tick = fn; return { unref() {} }; },
    clearTimer: () => { tick = null; },
  });
  assert.equal(typeof tick, 'function');
  tick();
  tick();
  assert.deepEqual(sent, ['ping', 'ping']);
  keepalive.stop();
  assert.equal(tick, null);
  assert.ok(PREVIEW_KEEPALIVE_MS < PREVIEW_IDLE_MS);
});
