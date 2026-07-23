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

  test('keeps next-request input and compaction pressure independent from historical usage', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hello world' },
      { role: 'assistant', content: 'hi' },
    ];
    const lowUsage = computeContextPressure({
      messages,
      usage: { inputTokens: 1, cacheReadTokens: 0 },
      contextWindow: 100_000,
    });
    expect(lowUsage.nextRequestInputTokens).toBe(lowUsage.estimatedTokens);
    expect(lowUsage.compactionPressureTokens).toBe(lowUsage.estimatedTokens);
    expect(lowUsage.nextRequestInputTokens).toBeGreaterThan(1);

    const highUsage = computeContextPressure({
      messages,
      usage: { inputTokens: 12_000, cacheReadTokens: 3_000 },
      contextWindow: 100_000,
    });
    expect(highUsage.usageTokens).toBe(15_000);
    expect(highUsage.nextRequestInputTokens).toBe(highUsage.estimatedTokens);
    expect(highUsage.compactionPressureTokens).toBe(highUsage.estimatedTokens);
    expect(highUsage.nextRequestInputTokens).toBeLessThan(highUsage.usageTokens);
  });

  test('shouldCompact when pressure reaches 80% of the window', () => {
    const below = computeContextPressure({
      messages: [{ role: 'user', content: 'x'.repeat(315_000) }],
      usage: { inputTokens: 99_000 },
      contextWindow: 100_000,
    });
    expect(below.shouldCompact).toBe(false);
    expect(below.percent).toBe(79);

    const above = computeContextPressure({
      messages: [{ role: 'user', content: 'x'.repeat(320_000) }],
      usage: { inputTokens: 1 },
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
    expect(withDraft.nextRequestInputTokens).toBeGreaterThan(withoutDraft.nextRequestInputTokens);
    expect(withDraft.compactionPressureTokens).toBeGreaterThan(withoutDraft.compactionPressureTokens);
  });
});
