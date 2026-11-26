import type { TranslationKey } from '@peer-agent/i18n';
import type { BotChatMessage, BotDispositionMark } from './botConversationState.ts';

export type UserReplyWait = 'waiting' | 'deliveryIssue';

/** A reply acknowledges one input; its source tasks are not separate acknowledgements. */
export function userReceipt(
  message: Pick<BotChatMessage, 'pending' | 'inputId' | 'dispositions'>,
  replied: boolean,
  replyWait?: UserReplyWait,
): { labelKey: TranslationKey | null; retryInputId?: string; taskMarks: readonly BotDispositionMark[] } {
  const taskMarks = message.dispositions.filter(item => item.kind !== 'answered');
  const responded = replied || message.dispositions.some(item => item.kind === 'answered');
  if (message.pending === 'sending') return { labelKey: 'projectAgent.chat.sending', taskMarks };
  if (message.pending === 'unknown') return { labelKey: 'projectAgent.chat.inputUnconfirmed', retryInputId: message.inputId, taskMarks };
  if (message.pending === 'failed') return { labelKey: 'projectAgent.chat.failed', retryInputId: message.inputId, taskMarks };
  if (responded) return { labelKey: 'projectAgent.chat.replied', taskMarks };
  if (replyWait === 'deliveryIssue') return { labelKey: 'projectAgent.chat.reply.deliveryIssue', taskMarks };
  if (replyWait === 'waiting') return { labelKey: 'projectAgent.chat.receivedWaiting', taskMarks };
  if (message.pending === 'received') return { labelKey: 'projectAgent.chat.received', taskMarks };
  return { labelKey: message.inputId && !taskMarks.length ? 'projectAgent.chat.received' : null, taskMarks };
}
