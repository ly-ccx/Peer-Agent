import type { I18nRuntime } from '@zeus-atlas/i18n';
import type { AuthState, CapabilityManifest, CloudRuntimeState } from '@zeus-atlas/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { CapabilityWorkbench } from '../../capabilities/components/CapabilityWorkbench';
import { resolveConversationChannel } from '../state/channelRuntime';
import { useAgentList } from '../state/useAgentList';
import { useCloudChatRuntime } from '../state/useCloudChatRuntime';
import { usePinnedConversations } from '../state/usePinnedConversations';
import { DeveloperSettingsPanel } from '../../app/components/DeveloperSettingsPanel';
import { AutomationConsole } from './automation/AutomationConsole';
import { SettingsView } from './settings/SettingsView';
import { ConversationSidebar } from './sidebar/ConversationSidebar';
import { CloudChatThread } from './thread/CloudChatThread';

const SIDEBAR_WIDTH_KEY = 'zeus-atlas.sidebar.width.v1';
const SIDEBAR_WIDTH_DEFAULT = 300;
const SIDEBAR_WIDTH_MIN = 248;
const SIDEBAR_WIDTH_MAX = 420;

function clampSidebarWidth(width: number) {
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(width)));
}

function loadSidebarWidth() {
  if (typeof window === 'undefined') return SIDEBAR_WIDTH_DEFAULT;
  const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
  return Number.isFinite(stored) ? clampSidebarWidth(stored) : SIDEBAR_WIDTH_DEFAULT;
}

export function CloudChatSurface({
  authState,
  capabilities,
  cloudRuntime,
  i18n,
  onDeveloperSettingsChanged,
  onLocaleChanged,
  onAuthChanged,
}: {
  readonly authState: AuthState | null;
  readonly capabilities: readonly CapabilityManifest[];
  readonly cloudRuntime: CloudRuntimeState | null;
  readonly i18n: I18nRuntime;
  readonly onDeveloperSettingsChanged: () => Promise<void> | void;
  readonly onLocaleChanged?: () => Promise<void> | void;
  readonly onAuthChanged?: () => Promise<void> | void;
}) {
  const [draft, setDraft] = useState('');
  const [activeView, setActiveView] = useState<'chat' | 'plugins' | 'agents' | 'automations' | 'developer' | 'settings'>('chat');
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const sidebarResizeCleanupRef = useRef<((updateState?: boolean) => void) | null>(null);
  const {
    forgetPinnedConversation,
    pinnedConversationIds,
    togglePinnedConversation,
  } = usePinnedConversations(authState);
  const { agents, activeAgent, activeAgentId, setActiveAgentId } = useAgentList({ authState });
  const runtime = useCloudChatRuntime({ authState, cloudRuntime, activeAgentId });
  const automationConversations = runtime.conversations.filter((conversation) =>
    resolveConversationChannel(conversation) === 'automation',
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => () => {
    sidebarResizeCleanupRef.current?.(false);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.shiftKey || event.key.toLowerCase() !== 'd') return;
      if (!event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      setActiveView('developer');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const resetSidebarWidth = useCallback(() => {
    setSidebarWidth(SIDEBAR_WIDTH_DEFAULT);
  }, []);

  const startSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    sidebarResizeCleanupRef.current?.(false);
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    setIsResizingSidebar(true);

    const onPointerMove = (nextEvent: PointerEvent) => {
      setSidebarWidth(clampSidebarWidth(startWidth + nextEvent.clientX - startX));
    };
    const cleanup = (updateState = true) => {
      if (updateState) setIsResizingSidebar(false);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      if (sidebarResizeCleanupRef.current === cleanup) {
        sidebarResizeCleanupRef.current = null;
      }
    };
    const onPointerUp = () => cleanup();

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    sidebarResizeCleanupRef.current = cleanup;
  }, [sidebarWidth]);

  if (!runtime.canUseCloudChat) {
    return null;
  }

  return (
    <section
      className={`cloud-chat-surface ${isResizingSidebar ? 'resizing-sidebar' : ''}`}
      style={{ '--za-sidebar-width': `${sidebarWidth}px` } as CSSProperties}
    >
      <ConversationSidebar
        activeView={activeView}
        authState={authState}
        conversations={runtime.conversations}
        activeConversationId={runtime.state.conversation?.id}
        onStartNewConversation={() => {
          setActiveView('chat');
          runtime.startNewConversation();
        }}
        onOpenPlugins={() => setActiveView('plugins')}
        onOpenAutomations={() => setActiveView('automations')}
        onOpenSettings={() => setActiveView('settings')}
        onSelectConversation={(conversation) => {
          setActiveView('chat');
          void runtime.selectConversation(conversation);
        }}
        onTogglePinnedConversation={togglePinnedConversation}
        onOpenAgents={() => setActiveView('agents')}
        agents={agents}
        activeAgentId={activeAgentId}
        onSelectAgent={(agent) => {
          setActiveAgentId(agent.id);
          setActiveView('chat');
          runtime.startNewConversation();
        }}
        onDeleteConversation={(conversation) => {
          if (!window.confirm(i18n.t('chat.conversations.confirmDelete'))) return;
          forgetPinnedConversation(conversation);
          void runtime.deleteConversation(conversation);
        }}
        pinnedConversationIds={pinnedConversationIds}
        onLocaleChanged={onLocaleChanged}
        onAuthChanged={onAuthChanged}
        i18n={i18n}
      />
      <div
        className="sidebar-drag-strip"
        role="separator"
        aria-label={i18n.t('chat.sidebar.resize')}
        aria-orientation="vertical"
        aria-valuemin={SIDEBAR_WIDTH_MIN}
        aria-valuemax={SIDEBAR_WIDTH_MAX}
        aria-valuenow={sidebarWidth}
        tabIndex={0}
        onDoubleClick={resetSidebarWidth}
        onKeyDown={(event) => {
          if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(event.key)) {
            event.preventDefault();
          }
          if (event.key === 'ArrowLeft') setSidebarWidth((width) => clampSidebarWidth(width - 16));
          if (event.key === 'ArrowRight') setSidebarWidth((width) => clampSidebarWidth(width + 16));
          if (event.key === 'Home') setSidebarWidth(SIDEBAR_WIDTH_MIN);
          if (event.key === 'End') setSidebarWidth(SIDEBAR_WIDTH_MAX);
          if (event.key === 'Enter') resetSidebarWidth();
        }}
        onPointerDown={startSidebarResize}
      />

      {activeView === 'plugins' ? (
        <CapabilityWorkbench capabilities={capabilities} />
      ) : activeView === 'agents' ? (
        <section className="agent-list-page">
          <h2>{i18n.t('app.agents')}</h2>
          <div className="agent-grid">
            {agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                className={`agent-card ${agent.id === activeAgentId ? 'active' : ''}`}
                onClick={() => {
                  setActiveAgentId(agent.id);
                  setActiveView('chat');
                  runtime.startNewConversation();
                }}
              >
                <strong>{agent.name}</strong>
                {agent.description ? <p>{agent.description}</p> : null}
              </button>
            ))}
          </div>
        </section>
      ) : activeView === 'automations' ? (
        <AutomationConsole
          key="automation-console-v2"
          agentId={activeAgentId}
          automationConversations={automationConversations}
        />
      ) : activeView === 'developer' ? (
        <section className="developer-page" aria-label={i18n.t('developer.title')}>
          <DeveloperSettingsPanel
            authState={authState}
            i18n={i18n}
            onApplied={onDeveloperSettingsChanged}
          />
        </section>
      ) : activeView === 'settings' ? (
        <SettingsView
          authState={authState}
          i18n={i18n}
          onBack={() => setActiveView('chat')}
          onDeveloperSettingsChanged={onDeveloperSettingsChanged}
          onLocaleChanged={onLocaleChanged}
        />
      ) : (
        <CloudChatThread
          activeAgent={activeAgent}
          agents={agents}
          authState={authState}
          draft={draft}
          i18n={i18n}
          onSelectAgent={(agent) => {
            setActiveAgentId(agent.id);
            runtime.startNewConversation();
          }}
          runtime={runtime}
          setDraft={setDraft}
        />
      )}
    </section>
  );
}
