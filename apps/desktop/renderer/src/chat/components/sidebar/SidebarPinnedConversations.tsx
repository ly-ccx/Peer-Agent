import type { I18nRuntime } from '@zeus-atlas/i18n';
import type { Conversation } from '@zeus-atlas/protocol';
import { resolveConversationChannel } from '../../state/channelRuntime';
import { SidebarConversationRow } from './SidebarConversationRow';

function matchesSearch(conversation: Conversation, i18n: I18nRuntime, search: string) {
  if (!search) return true;
  const title = conversation.title || i18n.t('chat.conversations.untitled');
  const channel = i18n.t(`chat.channel.${resolveConversationChannel(conversation)}`);
  return `${title} ${channel} ${conversation.id}`.toLowerCase().includes(search);
}

export function SidebarPinnedConversations({
  activeConversationId,
  conversations,
  i18n,
  onDeleteConversation,
  onSelectConversation,
  onTogglePinnedConversation,
  pinnedConversationIds,
  search,
}: {
  readonly activeConversationId: Conversation['id'] | undefined;
  readonly conversations: readonly Conversation[];
  readonly i18n: I18nRuntime;
  readonly onDeleteConversation: (conversation: Conversation) => void;
  readonly onSelectConversation: (conversation: Conversation) => void;
  readonly onTogglePinnedConversation: (conversation: Conversation) => void;
  readonly pinnedConversationIds: ReadonlySet<Conversation['id']>;
  readonly search: string;
}) {
  const pinnedConversations = conversations.filter((conversation) =>
    pinnedConversationIds.has(conversation.id) && matchesSearch(conversation, i18n, search),
  );
  if (pinnedConversations.length === 0) return null;

  return (
    <section className="sidebar-group">
      <div className="sidebar-group-heading">
        <span>{i18n.t('app.pinned')}</span>
      </div>
      <div className="pinned-conversation-list">
        {pinnedConversations.map((conversation) => (
          <SidebarConversationRow
            key={conversation.conversationUuid}
            conversation={conversation}
            i18n={i18n}
            isActive={activeConversationId === conversation.id}
            isPinned
            onDeleteConversation={onDeleteConversation}
            onSelectConversation={onSelectConversation}
            onTogglePinnedConversation={onTogglePinnedConversation}
          />
        ))}
      </div>
    </section>
  );
}
