import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldDismissUpdateProgress } from './updateProgressDismiss.ts';

test('an open progress dialog closes once the download is ready', () => {
  assert.equal(shouldDismissUpdateProgress({
    open: true,
    trackingProgress: true,
    closing: false,
    phase: 'downloaded',
  }), true);
});

test('progress that is still running keeps the dialog', () => {
  assert.equal(shouldDismissUpdateProgress({
    open: true,
    trackingProgress: true,
    closing: false,
    phase: 'downloading',
  }), false);
});

test('the changelog exit is left to its own close animation', () => {
  assert.equal(shouldDismissUpdateProgress({
    open: true,
    trackingProgress: true,
    closing: true,
    phase: 'downloaded',
  }), false);
});

test('opening the dialog after install is ready does not auto-close a non-progress view', () => {
  assert.equal(shouldDismissUpdateProgress({
    open: true,
    trackingProgress: false,
    closing: false,
    phase: 'downloaded',
  }), false);
});
