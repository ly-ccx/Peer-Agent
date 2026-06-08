import type { I18nRuntime } from '@zeus-atlas/i18n';
import type { AuthState, Conversation, ConversationChannelFilter } from '@zeus-atlas/protocol';
import { useState } from 'react';
import type { AgentSummary } from '../../state/useAgentList';
import { countConversationsByChannel } from '../../state/channelRuntime';
import { SidebarAccountMenu } from './SidebarAccountMenu';
import { SidebarIcon } from './SidebarIcon';
import { SidebarChannels } from './SidebarChannels';
import { SidebarPinnedConversations } from './SidebarPinnedConversations';

type ConversationSidebarView = 'chat' | 'plugins' | 'agents' | 'automations' | 'developer' | 'settings';

interface ConversationSidebarProps {
  readonly activeView: ConversationSidebarView;
  readonly authState: AuthState | null;
  readonly conversations: readonly Conversation[];
  readonly activeConversationId: Conversation['id'] | undefined;
  readonly onStartNewConversation: () => void;
  readonly onOpenPlugins: () => void;
  readonly onOpenAgents: () => void;
  readonly onOpenAutomations: () => void;
  readonly onOpenSettings: () => void;
  readonly onSelectConversation: (conversation: Conversation) => void;
  readonly onTogglePinnedConversation: (conversation: Conversation) => void;
  readonly onDeleteConversation: (conversation: Conversation) => void;
  readonly agents: readonly AgentSummary[];
  readonly activeAgentId: number | null;
  readonly onSelectAgent: (agent: AgentSummary) => void;
  readonly onLocaleChanged?: () => Promise<void> | void;
  readonly onAuthChanged?: () => Promise<void> | void;
  readonly pinnedConversationIds: ReadonlySet<Conversation['id']>;
  readonly i18n: I18nRuntime;
}

export function ConversationSidebar({
  activeView,
  authState,
  conversations,
  activeConversationId,
  onStartNewConversation,
  onOpenPlugins,
  onOpenAutomations,
  onSelectConversation,
  onTogglePinnedConversation,
  onDeleteConversation,
  agents,
  activeAgentId,
  onSelectAgent,
  onOpenAgents,
  onLocaleChanged,
  onAuthChanged,
  onOpenSettings,
  pinnedConversationIds,
  i18n,
}: ConversationSidebarProps) {
  const [expandedChannel, setExpandedChannel] = useState<ConversationChannelFilter | null>(null);
  const [conversationSearch, setConversationSearch] = useState('');
  const channelCounts = countConversationsByChannel(conversations);
  const normalizedSearch = conversationSearch.trim().toLowerCase();

  // 用户身份印（名字 + 工号）已下沉到 SidebarAccountMenu 底部按钮，与设置入口
  // 合并为单一身份/设置位，避免侧栏顶部独占一区。窗口顶部 52px padding 留作
  // macOS 红绿灯空间，删 sidebar-brand 后视觉上仍不顶到 traffic light。
  return (
    <aside className="cloud-chat-conversations">
      <div className="sidebar-nav">
        <div className="codex-sidebar-actions">
          <button type="button" onClick={onStartNewConversation}>
            <SidebarIcon name="new" />
            <span>{i18n.t('chat.conversations.new')}</span>
          </button>
          <label className="sidebar-search-row">
            <SidebarIcon name="search" />
            <input
              value={conversationSearch}
              placeholder={i18n.t('app.search')}
              onChange={(event) => setConversationSearch(event.target.value)}
            />
          </label>
          <button
            type="button"
            className={activeView === 'plugins' ? 'active' : ''}
            onClick={() => {
              setExpandedChannel(null);
              onOpenPlugins();
            }}
          >
            <SidebarIcon name="plugins" />
            <span>{i18n.t('app.plugins')}</span>
          </button>
          <button
            type="button"
            className={activeView === 'automations' ? 'active' : ''}
            onClick={() => {
              setExpandedChannel(null);
              onOpenAutomations();
            }}
          >
            <SidebarIcon name="automation" />
            <span>{i18n.t('app.automations')}</span>
            {channelCounts.automation > 0 ? <small>{channelCounts.automation}</small> : null}
          </button>
          <button
            type="button"
            className={activeView === 'agents' ? 'active' : ''}
            onClick={() => {
              setExpandedChannel(null);
              onOpenAgents();
            }}
          >
            <SidebarIcon name="agent" />
            <span>{i18n.t('app.agents')}</span>
            {agents.length > 0 ? <small>{agents.length}</small> : null}
          </button>
        </div>

        <SidebarPinnedConversations
          activeConversationId={activeConversationId}
          conversations={conversations}
          i18n={i18n}
          onDeleteConversation={onDeleteConversation}
          onSelectConversation={onSelectConversation}
          onTogglePinnedConversation={onTogglePinnedConversation}
          pinnedConversationIds={pinnedConversationIds}
          search={normalizedSearch}
        />

        <SidebarChannels
          activeConversationId={activeConversationId}
          channelCounts={channelCounts}
          conversations={conversations}
          expandedChannel={expandedChannel}
          i18n={i18n}
          onDeleteConversation={onDeleteConversation}
          onSelectConversation={onSelectConversation}
          onTogglePinnedConversation={onTogglePinnedConversation}
          pinnedConversationIds={pinnedConversationIds}
          search={normalizedSearch}
          setExpandedChannel={setExpandedChannel}
        />
      </div>
      <div className="sidebar-footer">
        <SidebarAccountMenu
          authState={authState}
          i18n={i18n}
          onLocaleChanged={onLocaleChanged}
          onOpenSettings={onOpenSettings}
          onAuthChanged={onAuthChanged}
        />
      </div>
    </aside>
  );
}
