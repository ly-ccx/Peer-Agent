import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sourceFingerprint, verifyReview, continuousReplyPresencePassed, completedReplyActionsPassed } from './product-regression.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-product-gate-'));
  const output = mkdtempSync(path.join(os.tmpdir(), 'peer-product-report-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(output, { recursive: true, force: true }); });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(path.join(root, 'component.ts'), 'source-v1');
  mkdirSync(path.join(output, 'screenshots'));
  const bytes = 'test-only screenshot hash fixture';
  const shot = { id: 'screen.png', path: 'screenshots/screen.png', sha256: createHash('sha256').update(bytes).digest('hex') };
  writeFileSync(path.join(output, shot.path), bytes);
  const packet = { schemaVersion: 1, runId: 'run-1', sourceFingerprint: sourceFingerprint(root), screenshots: [shot], limits: ['synthetic'] };
  const review = { schemaVersion: 1, runId: packet.runId, sourceFingerprint: packet.sourceFingerprint,
    reviewer: { kind: 'ai', name: 'test reviewer', independent: false },
    screenshots: [{ ...shot, verdict: 'pass', notes: 'Specific observed hierarchy and action placement.' }], findings: [] };
  return { root, output, packet, review };
}
test('complete source-bound review passes with its stated limits and independence', t => {
  const f = fixture(t);
  assert.equal(verifyReview(f).status, 'passed');
  assert.equal(verifyReview(f).reviewer.independent, false);
});
test('missing, unreviewed, duplicate and vague screenshot judgments cannot pass', t => {
  for (const mode of ['missing', 'unreviewed', 'duplicate', 'vague']) {
    const f = fixture(t);
    if (mode === 'missing') f.review.screenshots = [];
    if (mode === 'unreviewed') f.review.screenshots[0].verdict = 'not_checked';
    if (mode === 'duplicate') f.review.screenshots.push(f.review.screenshots[0]);
    if (mode === 'vague') f.review.screenshots[0].notes = 'looks good';
    assert.throws(() => verifyReview(f), /review/);
  }
});
test('source edits and screenshot replacement revoke an earlier review', t => {
  const f = fixture(t);
  writeFileSync(path.join(f.root, 'component.ts'), 'source-v2');
  assert.throws(() => verifyReview(f), /stale/);
  f.packet.sourceFingerprint = f.review.sourceFingerprint = sourceFingerprint(f.root);
  writeFileSync(path.join(f.output, f.packet.screenshots[0].path), 'different screenshot');
  assert.throws(() => verifyReview(f), /Screenshot/);
});
test('another run and unidentified reviewers cannot pass', t => {
  const f = fixture(t);
  f.review.runId = 'other';
  assert.throws(() => verifyReview(f), /different source/);
  f.review.runId = f.packet.runId; f.review.reviewer.name = '';
  assert.throws(() => verifyReview(f), /reviewer/);
});
test('open or accepted blocking findings prevent product acceptance', t => {
  const f = fixture(t);
  f.review.findings = [{ screenshot: 'screen.png', severity: 'blocking', description: 'Clipped task action', disposition: 'accepted-limitation' }];
  assert.throws(() => verifyReview(f), /findings/);
  f.review.findings[0].disposition = 'resolved';
  assert.equal(verifyReview(f).status, 'passed');
});

test('continuous reply acceptance requires quiet prose states and every reply layout state', () => {
  const quietStates = ['first-paragraph', 'latest-paragraph-dark', 'latest-paragraph-light', 'preparing-read', 'reading-docked'];
  const states = [...quietStates, 'completed', 'short-question-dark', 'short-question-light', 'stopped', 'failed'];
  const cases = states.map(state => ({ state, aligned: true, fits: true, unifiedActivity: true,
    stableHeight: true, singleAction: true, quiet: quietStates.includes(state) }));
  assert.equal(continuousReplyPresencePassed({ cases }), true);
  for (const state of states) {
    assert.equal(continuousReplyPresencePassed({ cases: cases.filter(row => row.state !== state) }), false);
  }
  for (const state of quietStates) {
    assert.equal(continuousReplyPresencePassed({ cases: cases.map(row => row.state === state ? { ...row, quiet: false } : row) }), false);
  }
  for (const flag of ['aligned', 'fits', 'unifiedActivity', 'stableHeight', 'singleAction']) {
    assert.equal(continuousReplyPresencePassed({ cases: cases.map(row => ({ ...row, [flag]: false })) }), false);
  }
  assert.equal(continuousReplyPresencePassed(), false);
});

test('completed reply actions stay hidden until hover in both themes', () => {
  const themes = ['dark', 'light'].map(theme => ({ theme, visibleAtRest: false, afterCapture: { opacity: '1' } }));
  assert.equal(completedReplyActionsPassed({ themes }), true);
  assert.equal(completedReplyActionsPassed(), false);
  for (const theme of ['dark', 'light']) {
    assert.equal(completedReplyActionsPassed({ themes: themes.filter(row => row.theme !== theme) }), false);
    assert.equal(completedReplyActionsPassed({ themes: themes.map(row => row.theme === theme
      ? { theme, visibleAtRest: true, afterCapture: { opacity: '1' } } : row) }), false);
    assert.equal(completedReplyActionsPassed({ themes: themes.map(row => row.theme === theme
      ? { ...row, visibleAtRest: true } : row) }), false);
    assert.equal(completedReplyActionsPassed({ themes: themes.map(row => row.theme === theme
      ? { ...row, afterCapture: { opacity: '0' } } : row) }), false);
  }
});
