import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPACTION_PROGRESS_CONFIG,
  estimateCompactionProgressPercent,
  estimateSummaryChars,
  resolveMaxSummaryChars,
} from './compaction-progress.ts';

const maxSummaryChars = resolveMaxSummaryChars({ maxOutputTokens: 12_000 });

test('estimateSummaryChars uses input×ratio instead of the physical output cap', () => {
  const inputChars = 120_000;
  const denom = estimateSummaryChars({ inputChars, maxSummaryChars, receivedChars: 0 });

  assert.ok(denom < maxSummaryChars, `denominator should be below physical cap, got ${denom}`);
  assert.equal(denom, Math.round(inputChars * COMPACTION_PROGRESS_CONFIG.summaryCompressionRatio));

  const realSummaryChars = 14_000;
  const denomAtEnd = estimateSummaryChars({
    inputChars,
    maxSummaryChars,
    receivedChars: realSummaryChars,
  });
  const percent = (realSummaryChars / denomAtEnd) * 100;
  assert.ok(percent >= 80, `expected near-complete percent at stream end, got ${percent.toFixed(1)}%`);
});

test('estimateSummaryChars stays monotonic and never reaches 100% before done', () => {
  const inputChars = 2_000;
  let prevPercent = -1;
  for (let received = 0; received <= 30_000; received += 1_000) {
    const percent = estimateCompactionProgressPercent({
      inputChars,
      maxSummaryChars,
      receivedChars: received,
    });
    assert.ok(
      percent >= prevPercent,
      `percent regressed: ${percent} < ${prevPercent} at received=${received}`,
    );
    prevPercent = percent;
    if (received > 0) {
      assert.ok(percent <= COMPACTION_PROGRESS_CONFIG.maxLivePercent);
    }
  }
});

test('estimateSummaryChars clamps to [min, maxSummaryChars] and handles invalid input', () => {
  assert.equal(
    estimateSummaryChars({ inputChars: 0, maxSummaryChars, receivedChars: 0 }),
    COMPACTION_PROGRESS_CONFIG.minEstimatedSummaryChars,
  );
  assert.equal(
    estimateSummaryChars({ inputChars: 10_000_000, maxSummaryChars, receivedChars: 0 }),
    maxSummaryChars,
  );
  assert.equal(
    estimateSummaryChars({
      inputChars: 10_000_000,
      maxSummaryChars,
      receivedChars: maxSummaryChars,
    }),
    maxSummaryChars,
  );
});

test('estimateCompactionProgressPercent uses received/estimated and done=100', () => {
  const inputChars = 50_000;
  const mid = estimateCompactionProgressPercent({
    inputChars,
    maxSummaryChars,
    receivedChars: 2_000,
  });
  assert.ok(mid > 0 && mid < 100);

  const done = estimateCompactionProgressPercent({
    inputChars,
    maxSummaryChars,
    receivedChars: 2_000,
    done: true,
  });
  assert.equal(done, 100);
});

test('estimateCompactionProgressPercent honors minPercent floor', () => {
  const percent = estimateCompactionProgressPercent({
    inputChars: 50_000,
    maxSummaryChars,
    receivedChars: 1,
    minPercent: COMPACTION_PROGRESS_CONFIG.stagePreparedPercent,
  });
  assert.ok(percent >= COMPACTION_PROGRESS_CONFIG.stagePreparedPercent);
});

test('resolveMaxSummaryChars falls back to default output budget', () => {
  assert.equal(resolveMaxSummaryChars({ maxOutputTokens: 4096 }), 4096 * 4);
  assert.equal(resolveMaxSummaryChars({}), 12_000 * 4);
});
