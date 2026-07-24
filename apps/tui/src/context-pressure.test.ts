import { describe, expect, test } from 'bun:test';

import type { ModelMessage } from '@peer-agent/runtime-node';

import {
  computeContextPressure,
  computeNextRequestInputTokens,
  estimateTokensFromMessages,
  estimateToolsTokens,
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

  test('tools schema raises nextRequestInputTokens (Desktop-aligned)', () => {
    const messages: ModelMessage[] = [{ role: 'user', content: 'seed' }];
    const tools = [
      {
        name: 'local.bash',
        description: 'Run a shell command',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string' },
          },
          required: ['command'],
        },
      },
      {
        name: 'local.file.read',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
          },
          required: ['path'],
        },
      },
    ];

    const withoutTools = computeContextPressure({ messages, contextWindow: 1_000 });
    const withTools = computeContextPressure({ messages, tools, contextWindow: 1_000 });
    const toolOnly = estimateToolsTokens(tools);

    expect(toolOnly).toBeGreaterThan(0);
    expect(withTools.nextRequestInputTokens).toBe(
      withoutTools.nextRequestInputTokens + toolOnly,
    );
    expect(withTools.nextRequestInputTokens).toBeGreaterThan(withoutTools.nextRequestInputTokens);
    expect(withTools.percent).toBeGreaterThan(withoutTools.percent ?? 0);
    expect(computeNextRequestInputTokens({ messages, tools })).toBe(
      withTools.nextRequestInputTokens,
    );
  });

  test('shared nextRequest budget matches Desktop formula: messages + tools', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call-1', name: 'local.bash', input: { command: 'ls' } },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'tool_result', id: 'call-1', content: 'ok' }],
      },
    ] as unknown as ModelMessage[];
    const tools = [
      {
        name: 'local.bash',
        description: 'Run a shell command',
        parameters: { type: 'object', properties: { command: { type: 'string' } } },
      },
    ];

    const messageTokens = estimateTokensFromMessages(messages);
    const toolTokens = estimateToolsTokens(tools);
    const next = computeNextRequestInputTokens({ messages, tools });
    expect(next).toBe(messageTokens + toolTokens);

    // Desktop toolCallBlockOverhead is 8; tool_use + tool_result must not use the old TUI 4.
    expect(TUI_COMPACTION_CONFIG.toolCallBlockOverhead).toBe(8);
    expect(TUI_COMPACTION_CONFIG.toolDefinitionOverhead).toBe(16);
  });
});
