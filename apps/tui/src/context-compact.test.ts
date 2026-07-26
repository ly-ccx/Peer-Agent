import { describe, expect, test } from 'bun:test';
import type { ModelMessage } from '@peer-agent/runtime-node';

import {
  buildHandoffContent,
  buildStructuralSummary,
  formatCompactMethodLabel,
  TUI_COMPACT_KEEP_RECENT,
} from './context-compact.ts';

// 切分算法已统一到 runtime-core splitMessagesForCompaction(见 23 号治理文档);
// 本文件只覆盖 TUI 保留的结构化摘要与 handoff 文本生成。

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

  test('records a trailing user message without an assistant reply', () => {
    const summary = buildStructuralSummary([
      user('answered request'),
      assistant('answer'),
      user('pending request'),
    ]);

    expect(summary).toContain('**User**: pending request');
    expect(summary).toContain('(no reply yet in compacted span)');
  });

  test('handoff content carries the shared marker framing and summary body', () => {
    const handoff = buildHandoffContent('## Structural body', 42);

    expect(handoff).toContain('[Context handoff — compacted 42 messages]');
    expect(handoff).toContain('Do not redo completed work.');
    expect(handoff).toContain('## Structural body');
  });

  test('uses default keep-recent window size', () => {
    expect(TUI_COMPACT_KEEP_RECENT).toBe(8);
  });

  test('formatCompactMethodLabel maps cascade methods for UI', () => {
    expect(formatCompactMethodLabel('llm')).toBe('LLM');
    expect(formatCompactMethodLabel('structured')).toBe('Structural');
    expect(formatCompactMethodLabel('fallback_drop')).toBe('Fallback');
    expect(formatCompactMethodLabel(undefined)).toBe('Unknown');
  });
});
