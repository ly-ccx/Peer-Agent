import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  mergeAuthoritativeContextSnapshot,
  resolveContextOccupancyTokens,
  resolveContextRingTokens,
  seedAuthoritativeContextOnSend,
} from './contextOccupancy.ts';

describe('unified next-request context projection', () => {
  it('adds draft to the authoritative next-request projection', () => {
    assert.equal(resolveContextOccupancyTokens({
      authoritativeNextRequestInputTokens: 40_000,
      historyContextTokens: 10_000,
      draftContextTokens: 2_000,
    }), 42_000);
  });

  it('keeps an existing conversation unknown until messages and its Runtime snapshot finish restoring', () => {
    assert.equal(resolveContextOccupancyTokens({
      authoritativeNextRequestInputTokens: null,
      historyContextTokens: 0,
      draftContextTokens: 0,
      contextReady: false,
    }), null);
  });

  it('falls back to restored local history when no Runtime projection exists', () => {
    assert.equal(resolveContextOccupancyTokens({
      authoritativeNextRequestInputTokens: null,
      historyContextTokens: 10_000,
      draftContextTokens: 2_000,
      contextReady: true,
    }), 12_000);
  });

  it('seeds the sent draft so clearing the composer does not lower the ring', () => {
    const seeded = seedAuthoritativeContextOnSend({
      previousNextRequestInputTokens: 40_000,
      historyContextTokens: 10_000,
      draftContextTokens: 2_000,
      contextWindow: 128_000,
    });
    assert.deepEqual(seeded, {
      nextRequestInputTokens: 42_000,
      contextWindow: 128_000,
    });
  });

  it('never substitutes lifetime billing usage for context occupancy', () => {
    assert.equal(resolveContextRingTokens(undefined), null);
    assert.equal(resolveContextRingTokens(Number.NaN), null);
    assert.equal(resolveContextRingTokens(-10), 0);
    assert.equal(resolveContextRingTokens(60_000), 60_000);
  });

  it('does not let an out-of-order midturn snapshot lower the projection', () => {
    const next = mergeAuthoritativeContextSnapshot({
      previous: { nextRequestInputTokens: 80_000, contextWindow: 128_000 },
      nextRequestInputTokens: 60_000,
      nextWindow: 128_000,
      mode: 'midturn',
    });
    assert.equal(next?.nextRequestInputTokens, 80_000);
  });

  it('allows stream completion or compaction to replace the projection', () => {
    const next = mergeAuthoritativeContextSnapshot({
      previous: { nextRequestInputTokens: 80_000, contextWindow: 128_000 },
      nextRequestInputTokens: 30_000,
      nextWindow: 128_000,
      mode: 'final',
    });
    assert.deepEqual(next, {
      nextRequestInputTokens: 30_000,
      contextWindow: 128_000,
    });
  });
});
