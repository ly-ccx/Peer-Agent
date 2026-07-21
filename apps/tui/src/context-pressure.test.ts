import { describe, expect, test } from 'bun:test';

import type { ModelMessage } from '@peer-agent/runtime-node';

import {
  computeContextPressure,
  estimateTokensFromMessages,
  TUI_COMPACTION_CONFIG,
} from './context-pressure.ts';

describe('context pressure', () => {
  test('estimates CJK text higher than plain english of same length', () => {
    const english: ModelMessage[] = [{ role: 'user', content: 'a'.repeat(100) }];
    const cjk: ModelMessage[] = [{ role: 'user', content: '中'.repeat(100) }];
    expect(estimateTokensFromMessages(cjk)).toBeGreaterThan(estimateTokensFromMessages(english));
  });

  test('triggerTokens prefers the larger of estimate and usage', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hello world' },
      { role: 'assistant', content: 'hi' },
    ];
    const lowUsage = computeContextPressure({
      messages,
      usage: { inputTokens: 1, cacheReadTokens: 0 },
      contextWindow: 100_000,
    });
    expect(lowUsage.triggerTokens).toBe(lowUsage.estimatedTokens);
    expect(lowUsage.triggerTokens).toBeGreaterThan(1);

    const highUsage = computeContextPressure({
      messages,
      usage: { inputTokens: 12_000, cacheReadTokens: 3_000 },
      contextWindow: 100_000,
    });
    expect(highUsage.triggerTokens).toBe(15_000);
    expect(highUsage.usageTokens).toBe(15_000);
  });

  test('shouldCompact when pressure reaches 80% of the window', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'x'.repeat(4_000) },
    ];
    const below = computeContextPressure({
      messages,
      usage: { inputTokens: 79_000 },
      contextWindow: 100_000,
    });
    expect(below.shouldCompact).toBe(false);
    expect(below.percent).toBe(79);

    const above = computeContextPressure({
      messages,
      usage: { inputTokens: 80_000 },
      contextWindow: 100_000,
    });
    expect(above.shouldCompact).toBe(true);
    expect(above.triggerRatio).toBe(TUI_COMPACTION_CONFIG.triggerRatio);
    expect(above.percent).toBe(80);
  });

  test('draft text raises estimated pressure', () => {
    const messages: ModelMessage[] = [{ role: 'user', content: 'seed' }];
    const withoutDraft = computeContextPressure({ messages, contextWindow: 100_000 });
    const withDraft = computeContextPressure({
      messages,
      contextWindow: 100_000,
      draftText: 'd'.repeat(4_000),
    });
    expect(withDraft.estimatedTokens).toBeGreaterThan(withoutDraft.estimatedTokens);
    expect(withDraft.triggerTokens).toBeGreaterThan(withoutDraft.triggerTokens);
  });
});
