import type { I18nRuntime } from '@zeus-atlas/i18n';
import type { Conversation, ConversationChannelFilter } from '@zeus-atlas/protocol';
import {
  CHANNEL_FILTERS,
  matchesChannelFilter,
  resolveConversationChannel,
} from '../../state/channelRuntime';
import { SidebarConversationRow } from './SidebarConversationRow';

type ChannelCounts = Record<ConversationChannelFilter, number>;

const SIDEBAR_CHANNELS = CHANNEL_FILTERS.filter(
  (channel) => channel !== 'all' && channel !== 'automation' && !channel.startsWith('dingtalk'),
);

function channelLabel(channel: ConversationChannelFilter, i18n: I18nRuntime) {
  return i18n.t(`chat.channel.${channel}`);
}

function visibleConversationsForChannel(params: {
  readonly channel: ConversationChannelFilter;
  readonly conversations: readonly Conversation[];
  readonly i18n: I18nRuntime;
  readonly search: string;
}) {
  const channelConversations = params.conversations.filter((conversation) =>
    matchesChannelFilter(conversation, params.channel),
  );
  const visibleConversations = !params.search ? channelConversations : channelConversations.filter((conversation) => {
    const title = conversation.title || params.i18n.t('chat.conversations.untitled');
    const resolvedChannel = channelLabel(resolveConversationChannel(conversation), params.i18n);
    return `${title} ${resolvedChannel}`.toLowerCase().includes(params.search);
  });
  return visibleConversations;
}

export function SidebarChannels({
  activeConversationId,
  channelCounts,
  conversations,
  expandedChannel,
  i18n,
  onDeleteConversation,
  onSelectConversation,
  onTogglePinnedConversation,
  pinnedConversationIds,
  search,
  setExpandedChannel,
}: {
  readonly activeConversationId: Conversation['id'] | undefined;
  readonly channelCounts: ChannelCounts;
  readonly conversations: readonly Conversation[];
  readonly expandedChannel: ConversationChannelFilter | null;
  readonly i18n: I18nRuntime;
  readonly onDeleteConversation: (conversation: Conversation) => void;
  readonly onSelectConversation: (conversation: Conversation) => void;
  readonly onTogglePinnedConversation: (conversation: Conversation) => void;
  readonly pinnedConversationIds: ReadonlySet<Conversation['id']>;
  readonly search: string;
  readonly setExpandedChannel: (channel: ConversationChannelFilter | null) => void;
}) {
  return (
    <section className="sidebar-group">
      <div className="sidebar-group-heading">
        <span>Channels</span>
      </div>
      {SIDEBAR_CHANNELS.map((channel) => {
        const isExpanded = expandedChannel === channel;
        const visibleConversations = isExpanded
          ? visibleConversationsForChannel({ channel, conversations, i18n, search })
          : [];
        return (
          <div key={channel} className="channel-block">
            <button
              className={`channel-row ${isExpanded ? 'active' : ''}`}
              type="button"
              aria-expanded={isExpanded}
              onClick={() => setExpandedChannel(isExpanded ? null : channel)}
            >
              <span>{channelLabel(channel, i18n)}</span>
              <small>{channelCounts[channel]}</small>
            </button>
            {isExpanded ? (
              <div className="channel-conversation-list">
                {visibleConversations.length === 0 ? (
                  <p className="empty-inline">{i18n.t('chat.conversations.empty')}</p>
                ) : null}
                {visibleConversations.map((conversation) => (
                  <SidebarConversationRow
                    key={conversation.conversationUuid}
                    conversation={conversation}
                    i18n={i18n}
                    isActive={activeConversationId === conversation.id}
                    isPinned={pinnedConversationIds.has(conversation.id)}
                    onDeleteConversation={onDeleteConversation}
                    onSelectConversation={onSelectConversation}
                    onTogglePinnedConversation={onTogglePinnedConversation}
                  />
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
