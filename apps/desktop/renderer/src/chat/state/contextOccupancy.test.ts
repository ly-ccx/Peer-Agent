import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  mergeAuthoritativeContextSnapshot,
  resolveContextOccupancyTokens,
  resolveContextRingTokens,
  seedAuthoritativeContextOnSend,
} from './contextOccupancy.ts';

describe('resolveContextOccupancyTokens', () => {
  it('uses authoritative + draft before send (no sudden drop source)', () => {
    const tokens = resolveContextOccupancyTokens({
      authoritativeContextTokens: 60_000,
      historyContextTokens: 40_000,
      draftContextTokens: 3_000,
    });
    assert.equal(tokens, 63_000);
  });

  it('falls back to history + draft when no authoritative snapshot', () => {
    const tokens = resolveContextOccupancyTokens({
      historyContextTokens: 40_000,
      draftContextTokens: 5_000,
    });
    assert.equal(tokens, 45_000);
  });

  it('raises with streaming input when higher than base', () => {
    const tokens = resolveContextOccupancyTokens({
      authoritativeContextTokens: 50_000,
      historyContextTokens: 40_000,
      draftContextTokens: 0,
      streamingInputTokens: 80_000,
    });
    assert.equal(tokens, 80_000);
  });

  it('does not lower below authoritative+draft for lower streaming input', () => {
    const tokens = resolveContextOccupancyTokens({
      authoritativeContextTokens: 50_000,
      historyContextTokens: 40_000,
      draftContextTokens: 2_000,
      streamingInputTokens: 10_000,
    });
    assert.equal(tokens, 52_000);
  });
});

describe('seedAuthoritativeContextOnSend', () => {
  it('freezes pre-send occupancy so draft clear cannot drop the ring alone', () => {
    const seeded = seedAuthoritativeContextOnSend({
      previousAuthoritativeTokens: 60_000,
      historyContextTokens: 40_000,
      sentDraftTokens: 3_000,
      previousContextWindow: 200_000,
    });
    assert.equal(seeded.contextTokens, 63_000);
    assert.equal(seeded.triggerTokens, 63_000);
    assert.equal(seeded.contextWindow, 200_000);

    // After send, draft is empty; occupancy still uses the seeded authority.
    const afterSend = resolveContextOccupancyTokens({
      authoritativeContextTokens: seeded.contextTokens,
      historyContextTokens: 40_000,
      draftContextTokens: 0,
    });
    assert.equal(afterSend, 63_000);
  });

  it('carries previous trigger higher than context when seeding', () => {
    const seeded = seedAuthoritativeContextOnSend({
      previousAuthoritativeTokens: 60_000,
      previousTriggerTokens: 120_000,
      historyContextTokens: 40_000,
      sentDraftTokens: 3_000,
      previousContextWindow: 200_000,
    });
    assert.equal(seeded.contextTokens, 63_000);
    assert.equal(seeded.triggerTokens, 123_000);
  });

  it('uses history + draft when no previous authority', () => {
    const seeded = seedAuthoritativeContextOnSend({
      previousAuthoritativeTokens: null,
      historyContextTokens: 20_000,
      sentDraftTokens: 5_000,
      fallbackContextWindow: 128_000,
    });
    assert.equal(seeded.contextTokens, 25_000);
    assert.equal(seeded.triggerTokens, 25_000);
    assert.equal(seeded.contextWindow, 128_000);
  });
});

describe('resolveContextRingTokens', () => {
  it('never treats missing context as billing totals (prevents false 100%)', () => {
    assert.equal(resolveContextRingTokens(undefined), null);
    assert.equal(resolveContextRingTokens(null), null);
    assert.equal(resolveContextRingTokens(12_345), 12_345);
    assert.equal(resolveContextRingTokens(-1), 0);
  });
});

describe('mergeAuthoritativeContextSnapshot', () => {
  it('final mode writes absolute dual-field values including drops', () => {
    const next = mergeAuthoritativeContextSnapshot({
      previous: { contextTokens: 200_000, triggerTokens: 280_000, contextWindow: 500_000 },
      nextContextTokens: 80_000,
      nextTriggerTokens: 90_000,
      nextWindow: 500_000,
      mode: 'final',
    });
    assert.equal(next?.contextTokens, 80_000);
    assert.equal(next?.triggerTokens, 90_000);
    assert.equal(next?.contextWindow, 500_000);
  });

  it('midturn mode refuses unexplained drop for each field', () => {
    const next = mergeAuthoritativeContextSnapshot({
      previous: { contextTokens: 200_000, triggerTokens: 280_000, contextWindow: 500_000 },
      nextContextTokens: 50_000,
      nextTriggerTokens: 60_000,
      nextWindow: 500_000,
      mode: 'midturn',
    });
    assert.equal(next?.contextTokens, 200_000);
    assert.equal(next?.triggerTokens, 280_000);
  });

  it('midturn mode allows raise independently on each field', () => {
    const next = mergeAuthoritativeContextSnapshot({
      previous: { contextTokens: 100_000, triggerTokens: 120_000, contextWindow: 500_000 },
      nextContextTokens: 110_000,
      nextTriggerTokens: 180_000,
      nextWindow: 500_000,
      mode: 'midturn',
    });
    assert.equal(next?.contextTokens, 110_000);
    assert.equal(next?.triggerTokens, 180_000);
  });

  it('midturn mode allows drop when context window shrinks (model switch)', () => {
    const next = mergeAuthoritativeContextSnapshot({
      previous: { contextTokens: 200_000, triggerTokens: 280_000, contextWindow: 500_000 },
      nextContextTokens: 80_000,
      nextTriggerTokens: 90_000,
      nextWindow: 200_000,
      mode: 'midturn',
    });
    assert.equal(next?.contextTokens, 80_000);
    assert.equal(next?.triggerTokens, 90_000);
    assert.equal(next?.contextWindow, 200_000);
  });

  it('legacy nextTokens writes both fields for compatibility', () => {
    const next = mergeAuthoritativeContextSnapshot({
      previous: null,
      nextTokens: 42_000,
      nextWindow: 128_000,
      mode: 'final',
    });
    assert.equal(next?.contextTokens, 42_000);
    assert.equal(next?.triggerTokens, 42_000);
  });

  it('keeps previous when midturn next is missing', () => {
    const next = mergeAuthoritativeContextSnapshot({
      previous: { contextTokens: 120_000, triggerTokens: 150_000, contextWindow: 500_000 },
      nextTokens: null,
      mode: 'midturn',
    });
    assert.equal(next?.contextTokens, 120_000);
    assert.equal(next?.triggerTokens, 150_000);
  });

  it('ensures triggerTokens is never below contextTokens', () => {
    const next = mergeAuthoritativeContextSnapshot({
      previous: null,
      nextContextTokens: 100_000,
      nextTriggerTokens: 80_000,
      nextWindow: 200_000,
      mode: 'final',
    });
    assert.equal(next?.contextTokens, 100_000);
    assert.equal(next?.triggerTokens, 100_000);
  });
});
