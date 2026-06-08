import type { I18nRuntime } from '@zeus-atlas/i18n';
import type { Conversation } from '@zeus-atlas/protocol';

function parseConversationDate(conversation: Conversation) {
  const value = conversation.gmtModified || conversation.gmtCreate;
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatConversationTime(conversation: Conversation, locale: I18nRuntime['locale']) {
  const date = parseConversationDate(conversation);
  if (!date) return '';

  const now = Date.now();
  const diffMs = now - date.getTime();
  const absDiffMs = Math.abs(diffMs);
  const minutes = Math.floor(absDiffMs / 60000);
  const hours = Math.floor(absDiffMs / 3600000);
  const days = Math.floor(absDiffMs / 86400000);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });

  if (minutes < 1) return locale === 'zh-CN' ? '刚刚' : formatter.format(0, 'minute');
  if (minutes < 60) return formatter.format(-minutes, 'minute');
  if (hours < 24) return formatter.format(-hours, 'hour');
  if (days < 7) return formatter.format(-days, 'day');

  return new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric' }).format(date);
}
