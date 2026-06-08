import type { I18nRuntime } from '@zeus-atlas/i18n';
import type { Conversation } from '@zeus-atlas/protocol';
import { resolveConversationChannel } from '../../state/channelRuntime';
import { SidebarIcon } from './SidebarIcon';
import { formatConversationTime } from './sidebarConversationMeta';

function channelLabel(conversation: Conversation, i18n: I18nRuntime) {
  return i18n.t(`chat.channel.${resolveConversationChannel(conversation)}`);
}

function metaParts(conversation: Conversation, i18n: I18nRuntime) {
  return [
    channelLabel(conversation, i18n),
    `#${conversation.id}`,
    formatConversationTime(conversation, i18n.locale),
    i18n.t('chat.conversations.messageCount', { count: conversation.messageCount ?? 0 }),
  ].filter(Boolean);
}

export function SidebarConversationRow({
  conversation,
  i18n,
  isActive,
  isPinned,
  onDeleteConversation,
  onSelectConversation,
  onTogglePinnedConversation,
}: {
  readonly conversation: Conversation;
  readonly i18n: I18nRuntime;
  readonly isActive: boolean;
  readonly isPinned: boolean;
  readonly onDeleteConversation: (conversation: Conversation) => void;
  readonly onSelectConversation: (conversation: Conversation) => void;
  readonly onTogglePinnedConversation: (conversation: Conversation) => void;
}) {
  const resolvedChannel = resolveConversationChannel(conversation);
  return (
    <div
      className={`conversation-row channel-${resolvedChannel} ${isActive ? 'active' : ''}`}
    >
      <button
        type="button"
        className={`conversation-action ${isPinned ? 'active' : ''}`}
        aria-label={i18n.t(isPinned ? 'chat.conversations.unpin' : 'chat.conversations.pin')}
        title={i18n.t(isPinned ? 'chat.conversations.unpin' : 'chat.conversations.pin')}
        onClick={() => onTogglePinnedConversation(conversation)}
      >
        <SidebarIcon name="pin" />
      </button>
      <button
        className="conversation-main"
        type="button"
        onClick={() => onSelectConversation(conversation)}
      >
        <strong>{conversation.title || i18n.t('chat.conversations.untitled')}</strong>
        <span>{metaParts(conversation, i18n).join(' · ')}</span>
      </button>
      <button
        type="button"
        className="conversation-action danger"
        aria-label={i18n.t('chat.conversations.delete')}
        title={i18n.t('chat.conversations.delete')}
        onClick={() => onDeleteConversation(conversation)}
      >
        <SidebarIcon name="delete" />
      </button>
    </div>
  );
}
