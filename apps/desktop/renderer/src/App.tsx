import { createI18n } from '@peer-agent/i18n';
import type { LlmProviderConfigView } from '@peer-agent/protocol';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { LlmSettingsPanel } from './app/components/LlmSettingsPanel';
import { AppearancePanel } from './appearance/AppearancePanel';
import { getRuntimeIdentity } from './app/runtimeIdentity';
import { useDesktopBootstrap } from './app/state/useDesktopBootstrap';
import { ChatSurface } from './chat/components/ChatSurface';
import { Sidebar } from './chat/components/Sidebar';
import { clientApi } from './clientApi';

type AppPage = 'chat' | 'model-settings' | 'appearance';

interface ConversationMeta {
  id: string;
  title: string;
  messageCount: number;
  updatedAt: string;
}

function readSystemInstructions(settings: Record<string, unknown> | null | undefined): string {
  return typeof settings?.systemInstructions === 'string' ? settings.systemInstructions : '';
}

export function App() {
  const { initError, session } = useDesktopBootstrap();
  const i18n = useMemo(() => createI18n(session?.locale), [session?.locale]);
  const runtimeIdentity = useMemo(() => getRuntimeIdentity(), []);
  const [activePage, setActivePage] = useState<AppPage>('chat');
  const [providers, setProviders] = useState<readonly LlmProviderConfigView[]>([]);
  const [conversations, setConversations] = useState<readonly ConversationMeta[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [activeWorkspace, setActiveWorkspace] = useState<string | null>(null);
  // 任务续传(ADR 21):重启后 peek 回来的待办,带会话坐标。
  // App 负责切到 sessionId(回到中断现场)后,把 task 下发给 ChatSurface 自动发出。
  const [resumeTask, setResumeTask] = useState<{ sessionId: string; task: string; effort?: string } | null>(null);
  const [systemInstructions, setSystemInstructions] = useState(() =>
    readSystemInstructions(clientApi.initialSettings));

  const refreshProviders = useCallback(async () => {
    try { setProviders(await clientApi.llmListProviders()); } catch {}
  }, []);

  const refreshConversations = useCallback(async (wsPath?: string | null) => {
    const ws = wsPath !== undefined ? wsPath : activeWorkspace;
    try {
      const list = await clientApi.conversationsList({ workspacePath: ws }) as readonly ConversationMeta[];
      setConversations(list);
    } catch {}
  }, [activeWorkspace]);

  const refreshSettings = useCallback(async () => {
    try {
      setSystemInstructions(readSystemInstructions(await clientApi.getSettings()));
    } catch {}
  }, []);

  useEffect(() => {
    void refreshProviders();
    void refreshSettings();
    void clientApi.workspaceList().then((r) => {
      setActiveWorkspace(r.activeWorkspace);
      void refreshConversations(r.activeWorkspace);
    }).catch(() => {});
  }, [refreshProviders, refreshSettings, refreshConversations]);

  // 任务续传(ADR 21):重启后回到中断现场。
  // peek(只读不清)拿到会话锚定的待办 → 切到 sessionId(回到原会话)→ 存 resumeTask,
  // 由 ChatSurface 在该会话内自动发出;workspace 校验已由 main 侧 peek handler 完成。
  // 用 peek 而非 consume:发送成功前不删文件,抗 StrictMode 双挂载与未就绪时序。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const record = await clientApi.peekPendingTask();
        if (cancelled || !record) return;
        const sessionId = typeof record.sessionId === 'string' ? record.sessionId : null;
        const task = typeof record.task === 'string' ? record.task.trim() : '';
        if (!sessionId || !task) return;
        const effort =
          record.effort === 'low' || record.effort === 'default' || record.effort === 'high'
            ? record.effort
            : undefined;
        setActiveConversationId(sessionId);
        setActivePage('chat');
        setResumeTask({ sessionId, task, effort });
      } catch {
        // 无任务 / 文件损坏 / workspace 不匹配:静默降级为正常空白启动。
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const runtimeLabel = i18n.locale === 'zh-CN' ? runtimeIdentity.labelZh : runtimeIdentity.labelEn;
    document.title = `Peer Agent · ${runtimeLabel}`;
  }, [i18n.locale, runtimeIdentity]);

  const handleWorkspaceChanged = useCallback(async () => {
    const r = await clientApi.workspaceList();
    setActiveWorkspace(r.activeWorkspace);
    setActiveConversationId(null);
    void refreshConversations(r.activeWorkspace);
  }, [refreshConversations]);

  const handleNewChat = useCallback(async () => {
    const conv = await clientApi.conversationsCreate({ workspacePath: activeWorkspace }) as ConversationMeta;
    await refreshConversations();
    setActiveConversationId(conv.id);
    setActivePage('chat');
  }, [refreshConversations, activeWorkspace]);

  const handleSelectConversation = useCallback((id: string) => {
    setActiveConversationId(id);
    setActivePage('chat');
  }, []);

  const handleDeleteConversation = useCallback(async (id: string) => {
    await clientApi.conversationsDelete({ id });
    if (activeConversationId === id) setActiveConversationId(null);
    await refreshConversations();
  }, [activeConversationId, refreshConversations]);

  return (
    <main className="app-shell">
      {session ? (
        <div className="app-layout">
          <Sidebar
            conversations={conversations}
            activeConversationId={activeConversationId}
            activePage={activePage}
            i18n={i18n}
            runtimeIdentity={runtimeIdentity}
            onNewChat={handleNewChat}
            onSelectConversation={handleSelectConversation}
            onDeleteConversation={handleDeleteConversation}
            onOpenModelSettings={() => setActivePage('model-settings')}
            onOpenAppearance={() => setActivePage('appearance')}
            onWorkspaceChanged={handleWorkspaceChanged}
          />
          <section className="main-panel">
            <section className="thread">
              {activePage === 'model-settings' ? (
                <LlmSettingsPanel
                  i18n={i18n}
                  onBack={() => {
                    setActivePage('chat');
                    void refreshProviders();
                    void refreshSettings();
                  }}
                  onSystemInstructionsChanged={setSystemInstructions}
                />
              ) : activePage === 'appearance' ? (
                <AppearancePanel i18n={i18n} onBack={() => setActivePage('chat')} />
              ) : (
                <ChatSurface
                  i18n={i18n}
                  providers={providers}
                  conversationId={activeConversationId}
                  systemInstructions={systemInstructions}
                  resumeTask={resumeTask}
                  onResumeConsumed={() => {
                    setResumeTask(null);
                    void clientApi.clearPendingTask().catch(() => {});
                  }}
                  onOpenSettings={() => setActivePage('model-settings')}
                  onConversationUpdated={refreshConversations}
                  onBranch={(id) => { setActiveConversationId(id); void refreshConversations(); }}
                />
              )}
            </section>
          </section>
        </div>
      ) : (
        <section className="main-panel">
          <section className="thread">
            {initError ? <p className="running-note">{initError}</p> : null}
            {!session && !initError ? <p className="runtime-note">{i18n.t('thread.loading.bootstrap')}</p> : null}
          </section>
        </section>
      )}
    </main>
  );
}
