import { describe, expect, test } from 'bun:test';
import type { ModelMessage } from '@peer-agent/runtime-node';

import {
  buildStructuralSummary,
  compactModelMessagesStructurally,
  TUI_COMPACT_KEEP_RECENT,
} from './context-compact.ts';

function user(content: string): ModelMessage {
  return { role: 'user', content };
}

function assistant(content: string, toolCalls?: ModelMessage['toolCalls']): ModelMessage {
  return toolCalls ? { role: 'assistant', content, toolCalls } : { role: 'assistant', content };
}

describe('context-compact structural summary', () => {
  test('builds turn-oriented structural summary', () => {
    const summary = buildStructuralSummary([
      user('implement /compact'),
      assistant('working on it', [
        {
          id: 'call-1',
          name: 'bash',
          arguments: JSON.stringify({ command: 'rg compact apps/tui' }),
        },
      ]),
      { role: 'tool', name: 'bash', content: 'command-registry.ts', toolCallId: 'call-1' },
      assistant('found registry path'),
    ]);

    expect(summary).toContain('### Turn 1');
    expect(summary).toContain('**User**: implement /compact');
    expect(summary).toContain('bash');
    expect(summary).toContain('Tool result');
  });

  test('compacts older messages into one handoff and keeps recent window', () => {
    const messages: ModelMessage[] = [
      { role: 'system', content: 'system prompt' },
      ...Array.from({ length: 12 }, (_, index) => [
        user(`user-${index}`),
        assistant(`assistant-${index}`),
      ]).flat(),
    ];

    const result = compactModelMessagesStructurally(messages, { keepRecentCount: 4 });
    expect(result.compacted).toBe(true);
    expect(result.summarizedCount).toBe(20);
    expect(result.messages[0]).toEqual({ role: 'system', content: 'system prompt' });
    expect(result.messages[1]?.role).toBe('user');
    expect(String(result.messages[1]?.content)).toContain('Context handoff');
    expect(result.messages.slice(-4)).toEqual(messages.slice(-4));
    expect(result.afterCount).toBe(1 + 1 + 4);
  });

  test('no-ops when history is already within keep window', () => {
    const messages = [user('a'), assistant('b')];
    const result = compactModelMessagesStructurally(messages);
    expect(result).toMatchObject({
      compacted: false,
      reason: 'nothing-to-compact',
      beforeCount: 2,
      afterCount: 2,
    });
    expect(result.messages).toBe(messages);
  });

  test('uses default keep-recent window size', () => {
    expect(TUI_COMPACT_KEEP_RECENT).toBe(8);
  });
});
