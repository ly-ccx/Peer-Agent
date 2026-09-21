import assert from 'node:assert/strict';
import test from 'node:test';
import {
  markLabReportClosed,
  permissionFingerprint,
  shouldClickVisibleControl,
} from './lab-experiment.mjs';

test('same permission strip is clicked only once', () => {
  const fingerprint = permissionFingerprint('permission', 'button.allow:打开受治理预览');
  const first = shouldClickVisibleControl({ fingerprint, lastFingerprint: null, enabled: true });
  const second = shouldClickVisibleControl({ fingerprint, lastFingerprint: fingerprint, enabled: true });
  assert.equal(first, true);
  assert.equal(second, false);
});

test('disabled start button is not clicked every second', () => {
  const fingerprint = permissionFingerprint('plan-approval', '开始执行');
  const clicked = shouldClickVisibleControl({
    fingerprint,
    lastFingerprint: null,
    enabled: false,
  });
  assert.equal(clicked, false);
});

test('a new permission fingerprint may be clicked after the previous one', () => {
  const first = permissionFingerprint('permission', 'button.allow:打开预览');
  const second = permissionFingerprint('permission', 'button.allow:跑命令重建');
  assert.equal(shouldClickVisibleControl({ fingerprint: first, lastFingerprint: null }), true);
  assert.equal(shouldClickVisibleControl({ fingerprint: second, lastFingerprint: first }), true);
});

test('lab report closed is true only after the owned handle actually exited', () => {
  assert.equal(markLabReportClosed({ ok: true, signaled: true, exited: true }), true);
  assert.equal(markLabReportClosed({ ok: true, signaled: true, exited: false }), false);
  assert.equal(markLabReportClosed({ ok: true, signaled: true }), false);
  assert.equal(markLabReportClosed(null), false);
});
