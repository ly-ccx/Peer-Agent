import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_REPETITION_OPTIONS,
  detectTailRepetition,
} from './repetition-detector.mjs';

// 复现截图场景：同一 i18n 片段反复吐出。
const REPLAY_UNIT = "'updater.modal.downloadingTitle': '正在下载更新…',\\n ";

test('detects tail repetition when a short unit repeats many times', () => {
  const prefix = 'x'.repeat(DEFAULT_REPETITION_OPTIONS.minLength);
  const text = prefix + REPLAY_UNIT.repeat(40);

  const hit = detectTailRepetition(text);
  assert.ok(hit, 'expected a repetition hit');
  assert.equal(hit.period, REPLAY_UNIT.length);
  assert.ok(hit.repeats >= DEFAULT_REPETITION_OPTIONS.minRepeats);
  assert.equal(hit.unit, REPLAY_UNIT);
});

test('detects single-character flooding (e.g. runaway newlines)', () => {
  const text = 'a'.repeat(DEFAULT_REPETITION_OPTIONS.minLength) + '\n'.repeat(500);
  const hit = detectTailRepetition(text);
  assert.ok(hit, 'expected a repetition hit for single-char flood');
  assert.equal(hit.period, 1);
});

test('does not flag normal long prose without runaway repetition', () => {
  // 自然语言长文本：有重复词但不构成尾部高频周期。
  const sentence =
    'The quick brown fox jumps over the lazy dog while the sun sets slowly. ';
  let text = '';
  while (text.length < DEFAULT_REPETITION_OPTIONS.minLength + 2000) {
    text += sentence + Math.random().toString(36).slice(2) + ' ';
  }
  assert.equal(detectTailRepetition(text), null);
});

test('does not flag boilerplate code repeated only a few times', () => {
  const block = 'const value = compute(input);\n  return value;\n\n';
  const text = 'y'.repeat(DEFAULT_REPETITION_OPTIONS.minLength) + block.repeat(5);
  assert.equal(detectTailRepetition(text), null);
});

test('does not detect when text is shorter than minLength', () => {
  const text = REPLAY_UNIT.repeat(20);
  assert.ok(text.length < DEFAULT_REPETITION_OPTIONS.minLength);
  assert.equal(detectTailRepetition(text), null);
});

test('respects custom thresholds', () => {
  const unit = 'ab';
  const text = 'z'.repeat(100) + unit.repeat(10);
  // 默认 minLength 太大不会命中；放宽后应命中。
  assert.equal(detectTailRepetition(text), null);
  const hit = detectTailRepetition(text, {
    minLength: 50,
    minRepeats: 8,
    maxPeriod: 10,
  });
  assert.ok(hit);
  assert.equal(hit.period, unit.length);
});

test('handles non-string input gracefully', () => {
  assert.equal(detectTailRepetition(null), null);
  assert.equal(detectTailRepetition(undefined), null);
  assert.equal(detectTailRepetition(12345), null);
});
