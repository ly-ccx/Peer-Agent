import { createI18n } from '@peer-agent/i18n';
import type { LlmProviderConfigView } from '@peer-agent/protocol';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { SettingsPage } from './app/components/SettingsPage';
import { useDesktopBootstrap } from './app/state/useDesktopBootstrap';
import { ChatSurface } from './chat/components/ChatSurface';
import { Sidebar } from './chat/components/Sidebar';
import { clientApi } from './clientApi';

type AppPage = 'chat' | 'settings';
type ConversationStatus = 'active' | 'archived';
type ConversationView = 'active' | 'archived';

interface ConversationMeta {
  id: string;
  title: string;
  messageCount: number;
  updatedAt: string;
  status?: ConversationStatus;
  archivedAt?: string | null;
}

function readSystemInstructions(settings: Record<string, unknown> | null | undefined): string {
  return typeof settings?.systemInstructions === 'string' ? settings.systemInstructions : '';
}

function readReplyLanguage(settings: Record<string, unknown> | null | undefined): string {
  return typeof settings?.replyLanguage === 'string' ? settings.replyLanguage : '';
}

export function App() {
  const { availableLocales, initError, refreshBootstrap, session } = useDesktopBootstrap();
  const i18n = useMemo(() => createI18n(session?.locale), [session?.locale]);
  const [activePage, setActivePage] = useState<AppPage>('chat');
  const [conversationView, setConversationView] = useState<ConversationView>('active');
  // 窗口是否处于原生全屏。全屏时交通灯被系统隐藏,据此收掉顶部为其预留的留白。
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [providers, setProviders] = useState<readonly LlmProviderConfigView[]>([]);
  const [conversations, setConversations] = useState<readonly ConversationMeta[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  // 表达层状态:当前正在流式运行的会话 id 集合,用于左侧列表显示 Loading 图标。
  // 真值来自 main 的 activeStreams:挂载时经 chatStreamListActive 拉取,之后由
  // onChatActiveStreamsChanged 广播实时更新——因此无需"点进会话"即可显示运行状态。
  // 另外 ChatSurface 的 onStreamingChange 作为本会话的即时信号合并进集合(更快反馈)。
  const [runningConversationIds, setRunningConversationIds] = useState<ReadonlySet<string>>(
    () => new Set());
  // ADR 27: 有运行中流的工作区路径集合,由活跃流投影的 streams 维度派生。
  // 让侧栏能提示"其它工作区仍有任务在跑",避免切换工作区后误以为任务丢失。
  const [runningWorkspacePaths, setRunningWorkspacePaths] = useState<ReadonlySet<string>>(
    () => new Set());
  const [activeWorkspace, setActiveWorkspace] = useState<string | null>(null);
  // ADR 21: main 进程可能已写入 PendingTask(例如重启恢复)。renderer 只负责
  // 切到 task.sessionId(回到中断现场)后,把 task 下发给 ChatSurface 自动发出。
  const [resumeTask, setResumeTask] = useState<{ sessionId: string; task: string; effort?: string } | null>(null);
  const [systemInstructions, setSystemInstructions] = useState(() =>
    readSystemInstructions(clientApi.initialSettings));
  const [replyLanguage, setReplyLanguage] = useState(() =>
    readReplyLanguage(clientApi.initialSettings));

  const refreshProviders = useCallback(async () => {
    try { setProviders(await clientApi.llmListProviders()); } catch {}
  }, []);

  const refreshConversations = useCallback(async (wsPath?: string | null, view?: ConversationView) => {
    const ws = wsPath !== undefined ? wsPath : activeWorkspace;
    const status = view ?? conversationView;
    try {
      const list = await clientApi.conversationsList({ workspacePath: ws, status }) as readonly ConversationMeta[];
      setConversations(list);
    } catch {}
  }, [activeWorkspace, conversationView]);

  const refreshSettings = useCallback(async () => {
    try {
      const settings = await clientApi.getSettings();
      setSystemInstructions(readSystemInstructions(settings));
      setReplyLanguage(readReplyLanguage(settings));
    } catch {}
  }, []);

  useEffect(() => {
    void refreshProviders();
    void refreshSettings();
    void clientApi.workspaceList().then((r) => {
      setActiveWorkspace(r.activeWorkspace);
      void clientApi.conversationsList({ workspacePath: r.activeWorkspace, status: 'active' })
        .then((list) => { setConversations(list as readonly ConversationMeta[]); })
        .catch(() => {});
    }).catch(() => {});
  }, [refreshProviders, refreshSettings]);

  // 任务续传(ADR 21):重启后回到中断现场。
  // peek(只读不清)拿到会话锚定的待办 → 切到 sessionId(回到原会话)→ 存 resumeTask,
  // 由 ChatSurface 在该会话内自动发出;workspace 校验已由 main 侧 peek handler 完成。
  // 用 peek 而非 consume:发送成功前不删文件,抗 StrictMode 双挂载与未就绪时序。
  useEffect(() => {
    let cancelled = false;
    void clientApi.peekPendingTask()
      .then((task) => {
        if (cancelled || !task) return;
        const sessionId = typeof task.sessionId === 'string' ? task.sessionId : '';
        const text = typeof task.task === 'string' ? task.task : '';
        if (!sessionId || !text) return;
        setActiveConversationId(sessionId);
        setConversationView('active');
        setActivePage('chat');
        setResumeTask({ sessionId, task: text, effort: typeof task.effort === 'string' ? task.effort : undefined });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    // 运行身份(本体/实验体)不再暴露到窗口标题,标题恒为 Peer Agent。
    document.title = 'Peer Agent';
  }, []);

  // 全屏时收掉为 macOS 交通灯预留的顶部留白。
  // 真值来自 main 的 window:fullscreen-changed 广播(:fullscreen CSS 伪类在 Electron
  // 原生全屏下不可靠),挂载后由 main 的 did-finish-load 补发一次初始状态。
  useEffect(() => {
    const unsubscribe = clientApi.onWindowFullscreenChanged(({ fullscreen }) => {
      setIsFullscreen(Boolean(fullscreen));
    });
    return unsubscribe;
  }, []);

  // 全局运行中会话:挂载时拉取当前活跃流快照,并订阅后续变更广播。
  // 这让左侧列表无需"点进去"即可知道哪些会话正在跑(含后台并行会话)。
  useEffect(() => {
    // ADR 27: streams 携带工作区维度,据此派生"哪些工作区有运行中的流"。
    const applyStreams = (
      conversationIds: readonly string[],
      streams: readonly { conversationId: string; workspacePath: string | null }[],
    ) => {
      setRunningConversationIds(new Set(conversationIds));
      const wsPaths = new Set<string>();
      for (const s of streams) {
        if (s.workspacePath) wsPaths.add(s.workspacePath);
      }
      setRunningWorkspacePaths(wsPaths);
    };
    void clientApi.chatStreamListActive()
      .then(({ conversationIds, streams }) => applyStreams(conversationIds, streams ?? []))
      .catch(() => {});
    const unsubscribe = clientApi.onChatActiveStreamsChanged(({ conversationIds, streams }) => {
      applyStreams(conversationIds, streams ?? []);
    });
    return unsubscribe;
  }, []);

  const handleWorkspaceChanged = useCallback(async () => {
    const r = await clientApi.workspaceList();
    setActiveWorkspace(r.activeWorkspace);
    setActiveConversationId(null);
    setConversationView('active');
    await refreshConversations(r.activeWorkspace, 'active');
  }, [refreshConversations]);

  const handleNewChat = useCallback(async () => {
    // 没有工作区时不允许把对话落到根目录:先确保有一个工作区(必要时默认初始化)。
    let ws = activeWorkspace;
    if (!ws) {
      const ensured = await clientApi.workspaceEnsureDefault();
      ws = ensured.path;
      setActiveWorkspace(ws);
    }
    const conv = await clientApi.conversationsCreate({ workspacePath: ws }) as ConversationMeta;
    setConversationView('active');
    await refreshConversations(ws, 'active');
    setActiveConversationId(conv.id);
    setActivePage('chat');
  }, [refreshConversations, activeWorkspace]);

  const handleSelectConversation = useCallback((id: string) => {
    setActiveConversationId(id);
    setActivePage('chat');
  }, []);

  const handleShowArchivedConversations = useCallback(async () => {
    setConversationView('archived');
    setActiveConversationId(null);
    setActivePage('chat');
    setConversations([]);
    await refreshConversations(activeWorkspace, 'archived');
  }, [activeWorkspace, refreshConversations]);

  const handleShowActiveConversations = useCallback(async () => {
    setConversationView('active');
    setActiveConversationId(null);
    setActivePage('chat');
    setConversations([]);
    await refreshConversations(activeWorkspace, 'active');
  }, [activeWorkspace, refreshConversations]);

  const handleArchiveConversation = useCallback(async (id: string) => {
    if (runningConversationIds.has(id)) return;
    await clientApi.conversationsArchive({ id });
    if (activeConversationId === id) setActiveConversationId(null);
    await refreshConversations(activeWorkspace, conversationView);
  }, [activeConversationId, activeWorkspace, conversationView, refreshConversations, runningConversationIds]);

  const handleRestoreConversation = useCallback(async (id: string) => {
    await clientApi.conversationsRestore({ id });
    await refreshConversations(activeWorkspace, conversationView);
  }, [activeWorkspace, conversationView, refreshConversations]);

  const handleDeleteConversation = useCallback(async (id: string) => {
    await clientApi.conversationsDelete({ id });
    if (activeConversationId === id) setActiveConversationId(null);
    await refreshConversations(activeWorkspace, conversationView);
  }, [activeConversationId, activeWorkspace, conversationView, refreshConversations]);

  const handleRenameConversation = useCallback(async (id: string, title: string) => {
    await clientApi.conversationsUpdateTitle({ id, title: title.trim() });
    await refreshConversations(activeWorkspace, conversationView);
  }, [activeWorkspace, conversationView, refreshConversations]);

  return (
    <main className={isFullscreen ? 'app-shell is-fullscreen' : 'app-shell'}>
      {session && activePage === 'settings' ? (
        <SettingsPage
          availableLocales={availableLocales}
          i18n={i18n}
          onBack={() => {
            setActivePage('chat');
            void refreshProviders();
            void refreshSettings();
          }}
          onLocaleChanged={refreshBootstrap}
          onReplyLanguageChanged={setReplyLanguage}
          onSystemInstructionsChanged={setSystemInstructions}
        />
      ) : session ? (
        <div className="app-layout">
          <Sidebar
            conversations={conversations}
            activeConversationId={activeConversationId}
            conversationView={conversationView}
            runningConversationIds={runningConversationIds}
            runningWorkspacePaths={runningWorkspacePaths}
            activePage={activePage}
            i18n={i18n}
            onNewChat={handleNewChat}
            onSelectConversation={handleSelectConversation}
            onDeleteConversation={handleDeleteConversation}
            onRenameConversation={handleRenameConversation}
            onArchiveConversation={handleArchiveConversation}
            onRestoreConversation={handleRestoreConversation}
            onShowArchivedConversations={handleShowArchivedConversations}
            onShowActiveConversations={handleShowActiveConversations}
            onOpenSettings={() => setActivePage('settings')}
            onWorkspaceChanged={handleWorkspaceChanged}
          />
          <section className="main-panel">
            <section className="thread">
              <ChatSurface
                i18n={i18n}
                providers={providers}
                conversationId={activeConversationId}
                systemInstructions={systemInstructions}
                replyLanguage={replyLanguage}
                resumeTask={resumeTask}
                onResumeConsumed={() => {
                  setResumeTask(null);
                  void clientApi.clearPendingTask().catch(() => {});
                }}
                onOpenSettings={() => setActivePage('settings')}
                onConversationUpdated={refreshConversations}
                onStreamingChange={(convId, streaming) => {
                  // 本会话即时信号:合并/移除到全局运行集合,作为广播之外的更快反馈。
                  // 权威真值仍由 main 的 active-changed 广播覆盖,二者最终一致。
                  if (!convId) return;
                  setRunningConversationIds((prev) => {
                    const has = prev.has(convId);
                    if (streaming === has) return prev;
                    const next = new Set(prev);
                    if (streaming) next.add(convId);
                    else next.delete(convId);
                    return next;
                  });
                }}
                onBranch={(id) => { setConversationView('active'); setActiveConversationId(id); void refreshConversations(activeWorkspace, 'active'); }}
              />
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
