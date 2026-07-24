import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  mergeAuthoritativeContextSnapshot,
  resolveContextOccupancyTokens,
  resolveContextRingTokens,
  seedAuthoritativeContextOnSend,
} from './contextOccupancy.ts';

describe('unified next-request context projection', () => {
  it('adds draft preview to the authoritative Runtime projection', () => {
    assert.equal(resolveContextOccupancyTokens({
      authoritativeNextRequestInputTokens: 40_000,
      draftContextTokens: 2_000,
    }), 42_000);
  });

  it('keeps context unknown until the Runtime projection is restored', () => {
    assert.equal(resolveContextOccupancyTokens({
      authoritativeNextRequestInputTokens: null,
      draftContextTokens: 2_000,
      contextReady: false,
    }), null);
    assert.equal(resolveContextOccupancyTokens({
      authoritativeNextRequestInputTokens: null,
      draftContextTokens: 2_000,
      contextReady: true,
    }), null);
  });

  it('never turns an invalid zero projection into local history truth', () => {
    assert.equal(resolveContextOccupancyTokens({
      authoritativeNextRequestInputTokens: 0,
      draftContextTokens: 2_000,
      contextReady: true,
    }), null);
  });

  it('seeds the sent draft so clearing the composer does not lower the ring', () => {
    assert.deepEqual(seedAuthoritativeContextOnSend({
      previousNextRequestInputTokens: 40_000,
      draftContextTokens: 2_000,
      contextWindow: 128_000,
    }), {
      nextRequestInputTokens: 42_000,
      contextWindow: 128_000,
    });
  });

  it('does not invent a seed when Runtime authority is missing', () => {
    assert.equal(seedAuthoritativeContextOnSend({
      previousNextRequestInputTokens: 0,
      draftContextTokens: 1_000,
      contextWindow: 128_000,
    }), null);
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

  it('rejects final zero so a missing projection cannot wipe the ring to 0%', () => {
    const next = mergeAuthoritativeContextSnapshot({
      previous: { nextRequestInputTokens: 80_000, contextWindow: 128_000 },
      nextRequestInputTokens: 0,
      nextWindow: 128_000,
      mode: 'final',
    });
    assert.deepEqual(next, {
      nextRequestInputTokens: 80_000,
      contextWindow: 128_000,
    });
  });
});
