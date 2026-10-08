import type { TranslationKey } from '@peer-agent/i18n';

export function cardActionErrorKey(code?: string): TranslationKey {
  if (['session_not_completed', 'stale_completion_review', 'not_confirmable', 'NOT_CONFIRMABLE'].includes(code || '')) return 'projectAgent.chat.resultChanged';
  return 'projectAgent.chat.actionFailed';
}
