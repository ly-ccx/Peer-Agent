import type { ModelMessage, ModelToolCall } from '@peer-agent/runtime-node';

/** Keep the most recent non-system messages after structural compaction. */
export const TUI_COMPACT_KEEP_RECENT = 8;

export interface StructuralCompactResult {
  readonly compacted: boolean;
  readonly messages: readonly ModelMessage[];
  readonly beforeCount: number;
  readonly afterCount: number;
  readonly summarizedCount: number;
  readonly reason?: 'empty' | 'nothing-to-compact';
}

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

function buildHandoffContent(summary: string, oldCount: number): string {
  return [
    `[Context handoff — compacted ${oldCount} messages]`,
    '',
    'This is a structural summary of earlier work. Continue from this handoff plus the recent messages that follow. Do not redo completed work.',
    '',
    '## Structural summary',
    summary,
  ].join('\n');
}

/**
 * Structurally compact model messages for TUI provider history.
 * Keeps the most recent non-system messages and replaces older ones with one handoff user message.
 */
export function compactModelMessagesStructurally(
  messages: readonly ModelMessage[],
  options: { readonly keepRecentCount?: number } = {},
): StructuralCompactResult {
  const keepRecentCount = options.keepRecentCount ?? TUI_COMPACT_KEEP_RECENT;
  const beforeCount = messages.length;
  if (beforeCount === 0) {
    return {
      compacted: false,
      messages,
      beforeCount,
      afterCount: 0,
      summarizedCount: 0,
      reason: 'empty',
    };
  }

  // Preserve any leading system messages outside the compact window.
  let systemPrefixCount = 0;
  while (systemPrefixCount < messages.length && messages[systemPrefixCount]?.role === 'system') {
    systemPrefixCount += 1;
  }

  const nonSystem = messages.slice(systemPrefixCount);
  if (nonSystem.length <= keepRecentCount) {
    return {
      compacted: false,
      messages,
      beforeCount,
      afterCount: beforeCount,
      summarizedCount: 0,
      reason: 'nothing-to-compact',
    };
  }

  const splitAt = nonSystem.length - keepRecentCount;
  const oldMessages = nonSystem.slice(0, splitAt);
  const keepMessages = nonSystem.slice(splitAt);
  const summary = buildStructuralSummary(oldMessages);
  const handoff: ModelMessage = {
    role: 'user',
    content: buildHandoffContent(summary, oldMessages.length),
  };

  const nextMessages: ModelMessage[] = [
    ...messages.slice(0, systemPrefixCount),
    handoff,
    ...keepMessages,
  ];

  return {
    compacted: true,
    messages: nextMessages,
    beforeCount,
    afterCount: nextMessages.length,
    summarizedCount: oldMessages.length,
  };
}
