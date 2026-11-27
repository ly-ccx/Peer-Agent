import type { TranslationKey } from '@peer-agent/i18n';
import type { BotChatMessage, BotDispositionMark } from './botConversationState.ts';

export type UserReplyWait = 'waiting' | 'deliveryIssue';

export interface UserReceipt {
  readonly labelKey: TranslationKey | null;
  readonly retryInputId?: string;
  readonly restoreInputId?: string;
  readonly discardInputId?: string;
  readonly requiresDiscardConfirm?: boolean;
  readonly taskMarks: readonly BotDispositionMark[];
}

export function rejectionLabelKey(code?: string): TranslationKey {
  if (code === 'QUESTION_CLOSED') return 'projectAgent.chat.inputRejectedQuestionClosed';
  if (code === 'RESOURCE_FEEDBACK_RECIPIENT_CHANGED'
    || code === 'INVALID_RESOURCE_FEEDBACK'
    || code === 'RESOURCE_FEEDBACK_ATTACHMENT_LIMIT'
    || code === 'INTERACTIVE_FEEDBACK_UNAVAILABLE') {
    return 'projectAgent.chat.inputRejectedResourceFeedback';
  }
  if (code === 'NOT_FOUND' || code === 'WORKSPACE_NOT_FOUND') return 'projectAgent.chat.inputRejectedTargetUnavailable';
  return 'projectAgent.chat.inputRejected';
}

export function canRestoreRejectedInput(code?: string): boolean {
  return code !== 'NOT_FOUND' && code !== 'WORKSPACE_NOT_FOUND';
}

/** A reply acknowledges one input; its source tasks are not separate acknowledgements. */
export function userReceipt(
  message: Pick<BotChatMessage, 'pending' | 'rejectionCode' | 'inputId' | 'dispositions'>,
  replied: boolean,
  replyWait?: UserReplyWait,
): UserReceipt {
  const taskMarks = message.dispositions.filter(item => item.kind !== 'answered');
  const responded = replied || message.dispositions.some(item => item.kind === 'answered');
  if (message.pending === 'sending') return { labelKey: 'projectAgent.chat.sending', taskMarks };
  if (message.pending === 'unknown') {
    return {
      labelKey: 'projectAgent.chat.inputUnconfirmed',
      retryInputId: message.inputId,
      restoreInputId: message.inputId,
      discardInputId: message.inputId,
      requiresDiscardConfirm: true,
      taskMarks,
    };
  }
  if (message.pending === 'rejected') {
    return {
      labelKey: rejectionLabelKey(message.rejectionCode),
      ...(canRestoreRejectedInput(message.rejectionCode) ? { restoreInputId: message.inputId } : {}),
      discardInputId: message.inputId,
      requiresDiscardConfirm: false,
      taskMarks,
    };
  }
  if (message.pending === 'failed') return { labelKey: 'projectAgent.chat.failed', retryInputId: message.inputId, taskMarks };
  if (responded) return { labelKey: 'projectAgent.chat.replied', taskMarks };
  if (replyWait === 'deliveryIssue') return { labelKey: 'projectAgent.chat.reply.deliveryIssue', taskMarks };
  if (replyWait === 'waiting') return { labelKey: 'projectAgent.chat.receivedWaiting', taskMarks };
  if (message.pending === 'received') return { labelKey: 'projectAgent.chat.received', taskMarks };
  return { labelKey: message.inputId && !taskMarks.length ? 'projectAgent.chat.received' : null, taskMarks };
}
