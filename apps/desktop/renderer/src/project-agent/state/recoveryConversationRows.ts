import type { BotRecoveryStatus } from '@peer-agent/protocol';
import type { BotConversationViewRow } from './botReplyContinuity.ts';

/** A received input does not create a blank assistant response while execution is blocked. */
export function recoveryConversationRows(rows: readonly BotConversationViewRow[], recovery: BotRecoveryStatus | null): readonly BotConversationViewRow[] {
  if (!recovery) return rows;
  return rows.filter(row => row.type !== 'reply' || row.messages.length > 0 || row.paragraphs.length > 0
    || row.activity && (row.activity.replyText.trim() || row.activity.segments.length))
    .map(row => row.type === 'reply' && row.activity ? { ...row, recovery } : row);
}
