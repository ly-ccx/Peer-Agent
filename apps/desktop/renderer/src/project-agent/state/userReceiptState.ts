import type { TranslationKey } from '@peer-agent/i18n';
import type { BotChatMessage, BotDispositionMark } from './botConversationState.ts';

/** A reply acknowledges one input; its source tasks are not separate acknowledgements. */
export function userReceipt(
  message: Pick<BotChatMessage, 'pending' | 'inputId' | 'dispositions'>,
  replied: boolean,
): { labelKey: TranslationKey | null; retryInputId?: string; taskMarks: readonly BotDispositionMark[] } {
  const taskMarks = message.dispositions.filter(item => item.kind !== 'answered');
  const responded = replied || message.dispositions.some(item => item.kind === 'answered');
  if (message.pending === 'sending') return { labelKey: 'projectAgent.chat.sending', taskMarks };
  if (message.pending === 'received') return { labelKey: 'projectAgent.chat.received', taskMarks };
  if (message.pending === 'failed') return { labelKey: 'projectAgent.chat.failed', retryInputId: message.inputId, taskMarks };
  if (responded) return { labelKey: 'projectAgent.chat.replied', taskMarks };
  return { labelKey: message.inputId && !taskMarks.length ? 'projectAgent.chat.received' : null, taskMarks };
}
