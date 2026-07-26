import type { ModelMessage, ModelToolCall } from '@peer-agent/runtime-node';
import type { CompactionMethod } from '@peer-agent/runtime-core';

/** Keep the most recent non-system messages after structural compaction. */
export const TUI_COMPACT_KEEP_RECENT = 8;

// 历史上这里还有一套私有切分 compactModelMessagesStructurally；
// 切分已统一到 runtime-core splitMessagesForCompaction（chat-controller 直接消费），
// 本模块只保留 TUI 结构化摘要与 handoff 文本生成，避免第二套切分算法回潮。
// 见 knowledge/architecture/23-compaction-path-root-governance.md。

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function messageText(message: ModelMessage): string {
  return typeof message.content === 'string' ? message.content : '';
}

function formatToolCalls(toolCalls: readonly ModelToolCall[] | undefined): string | null {
  if (!toolCalls?.length) return null;
  const rendered = toolCalls
    .map((call) => {
      const args = truncate(JSON.stringify(call.arguments ?? {}), 300);
      return `${call.name}(${args})`;
    })
    .join(', ');
  return rendered;
}

/**
 * Build a structural handoff summary from older model messages.
 * Intentionally local/deterministic (no LLM call) for CLI/TUI `/compact`.
 */
export function buildStructuralSummary(oldMessages: readonly ModelMessage[]): string {
  const parts: string[] = [];
  let turnCounter = 0;
  let currentUser: ModelMessage | null = null;

  for (const message of oldMessages) {
    if (message.role === 'user') {
      currentUser = message;
      continue;
    }

    if (message.role === 'assistant') {
      turnCounter += 1;
      parts.push(`\n### Turn ${turnCounter}`);

      if (currentUser) {
        const userContent = messageText(currentUser);
        parts.push(`**User**: ${truncate(userContent, 800)}`);
      } else {
        parts.push('**Context**: Continued execution inside the latest preserved user turn.');
      }

      const tools = formatToolCalls(message.toolCalls);
      if (tools) {
        parts.push(`**Assistant**: Executed ${tools}`);
      }

      const text = messageText(message);
      if (text.length > 5) {
        parts.push(`  Response: ${truncate(text, 500)}`);
      }

      currentUser = null;
      continue;
    }

    if (message.role === 'tool') {
      const content = messageText(message);
      parts.push(
        `  Tool result${message.name ? ` (${message.name})` : ''}: ${truncate(content, 300)}`,
      );
    }
  }

  // Trailing user message with no assistant reply yet.
  if (currentUser) {
    turnCounter += 1;
    parts.push(`\n### Turn ${turnCounter}`);
    parts.push(`**User**: ${truncate(messageText(currentUser), 800)}`);
    parts.push('**Assistant**: (no reply yet in compacted span)');
  }

  if (parts.length === 0) {
    return `Compacted ${oldMessages.length} earlier messages without recoverable turn structure.`;
  }

  return parts.join('\n').trim();
}


/** UI label for the shared Desktop/CLI compaction cascade method. */
export function formatCompactMethodLabel(method?: CompactionMethod | null): string {
  switch (method) {
    case 'llm':
      return 'LLM';
    case 'structured':
      return 'Structural';
    case 'fallback_drop':
      return 'Fallback';
    default:
      return 'Unknown';
  }
}

export function buildHandoffContent(summary: string, oldCount: number): string {
  return [
    `[Context handoff — compacted ${oldCount} messages]`,
    '',
    'This is a structural summary of earlier work. Continue from this handoff plus the recent messages that follow. Do not redo completed work.',
    '',
    '## Structural summary',
    summary,
  ].join('\n');
}

