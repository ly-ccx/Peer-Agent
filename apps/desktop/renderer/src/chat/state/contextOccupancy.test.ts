import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  resolveContextOccupancyTokens,
  resolveContextRingTokens,
  seedAuthoritativeContextOnSend,
} from './contextOccupancy.ts';

describe('resolveContextOccupancyTokens', () => {
  it('uses authoritative + draft before send (no sudden drop source)', () => {
    const tokens = resolveContextOccupancyTokens({
      authoritativeContextTokens: 50_000,
      historyContextTokens: 30_000,
      draftContextTokens: 13_000,
    });
    assert.equal(tokens, 63_000);
  });

  it('keeps occupancy after send when draft is cleared but authoritative was seeded', () => {
    // 发送前 63k；发送后草稿清零，权威种子应已并入 sent draft。
    const seeded = seedAuthoritativeContextOnSend({
      previousAuthoritativeTokens: 50_000,
      historyContextTokens: 30_000,
      sentDraftTokens: 13_000,
      previousContextWindow: 100_000,
    });
    assert.equal(seeded.contextTokens, 63_000);

    const afterSend = resolveContextOccupancyTokens({
      authoritativeContextTokens: seeded.contextTokens,
      historyContextTokens: 43_000, // 历史已含新 user，但可能仍低于权威（缺 system/tools）
      draftContextTokens: 0,
    });
    assert.equal(afterSend, 63_000);
  });

  it('does not fall back to local history while authoritative snapshot exists', () => {
    const tokens = resolveContextOccupancyTokens({
      authoritativeContextTokens: 63_000,
      historyContextTokens: 36_000,
      draftContextTokens: 0,
    });
    assert.equal(tokens, 63_000);
  });

  it('falls back to local history + draft when no authoritative snapshot', () => {
    const tokens = resolveContextOccupancyTokens({
      authoritativeContextTokens: null,
      historyContextTokens: 36_000,
      draftContextTokens: 2_000,
    });
    assert.equal(tokens, 38_000);
  });

  it('can rise with streaming input of the current provider request, not lifetime billing', () => {
    const tokens = resolveContextOccupancyTokens({
      authoritativeContextTokens: 63_000,
      historyContextTokens: 70_000,
      draftContextTokens: 0,
      streamingInputTokens: 72_000, // 本轮 input+cacheRead
    });
    assert.equal(tokens, 72_000);
  });

  it('ignores streaming input when it is smaller than the seeded occupancy', () => {
    const tokens = resolveContextOccupancyTokens({
      authoritativeContextTokens: 63_000,
      historyContextTokens: 40_000,
      draftContextTokens: 0,
      streamingInputTokens: 10_000,
    });
    assert.equal(tokens, 63_000);
  });
});

describe('seedAuthoritativeContextOnSend', () => {
  it('prevents 63% → 36% drop caused by clearing draft against stale authoritative', () => {
    const seeded = seedAuthoritativeContextOnSend({
      previousAuthoritativeTokens: 50_000,
      historyContextTokens: 23_000,
      sentDraftTokens: 13_000,
      previousContextWindow: 100_000,
      fallbackContextWindow: 200_000,
    });
    // max(50k+13k, 23k+13k) = 63k，而不是回落到 23k/36k 本地历史
    assert.equal(seeded.contextTokens, 63_000);
    assert.equal(seeded.contextWindow, 100_000);
  });

  it('uses history+sent when there is no previous authoritative snapshot', () => {
    const seeded = seedAuthoritativeContextOnSend({
      previousAuthoritativeTokens: null,
      historyContextTokens: 20_000,
      sentDraftTokens: 5_000,
      fallbackContextWindow: 128_000,
    });
    assert.equal(seeded.contextTokens, 25_000);
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
