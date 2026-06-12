import { createI18n } from '@peer-agent/i18n';
import type { LlmProviderConfigView } from '@peer-agent/protocol';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { SettingsPage } from './app/components/SettingsPage';
import { useDesktopBootstrap } from './app/state/useDesktopBootstrap';
import { ChatSurface } from './chat/components/ChatSurface';
import { Sidebar } from './chat/components/Sidebar';
import { clientApi } from './clientApi';

type AppPage = 'chat' | 'settings';

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
  const [activePage, setActivePage] = useState<AppPage>('chat');
  const [providers, setProviders] = useState<readonly LlmProviderConfigView[]>([]);
  const [conversations, setConversations] = useState<readonly ConversationMeta[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  // 表达层状态:当前正在流式运行的会话 id 集合,用于左侧列表显示 Loading 图标。
  // 真值来自 main 的 activeStreams:挂载时经 chatStreamListActive 拉取,之后由
  // onChatActiveStreamsChanged 广播实时更新——因此无需"点进会话"即可显示运行状态。
  // 另外 ChatSurface 的 onStreamingChange 作为本会话的即时信号合并进集合(更快反馈)。
  const [runningConversationIds, setRunningConversationIds] = useState<ReadonlySet<string>>(
    () => new Set());
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
          record.effort === 'off' || record.effort === 'low'
          || record.effort === 'default' || record.effort === 'high'
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
    // 运行身份(本体/实验体)不再暴露到窗口标题,标题恒为 Peer Agent。
    document.title = 'Peer Agent';
  }, []);

  // 全局运行中会话:挂载时拉取当前活跃流快照,并订阅后续变更广播。
  // 这让左侧列表无需"点进去"即可知道哪些会话正在跑(含后台并行会话)。
  useEffect(() => {
    void clientApi.chatStreamListActive()
      .then(({ conversationIds }) => setRunningConversationIds(new Set(conversationIds)))
      .catch(() => {});
    const unsubscribe = clientApi.onChatActiveStreamsChanged(({ conversationIds }) => {
      setRunningConversationIds(new Set(conversationIds));
    });
    return unsubscribe;
  }, []);

  const handleWorkspaceChanged = useCallback(async () => {
    const r = await clientApi.workspaceList();
    setActiveWorkspace(r.activeWorkspace);
    setActiveConversationId(null);
    void refreshConversations(r.activeWorkspace);
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
    await refreshConversations(ws);
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
      {session && activePage === 'settings' ? (
        <SettingsPage
          i18n={i18n}
          onBack={() => {
            setActivePage('chat');
            void refreshProviders();
            void refreshSettings();
          }}
          onSystemInstructionsChanged={setSystemInstructions}
        />
      ) : session ? (
        <div className="app-layout">
          <Sidebar
            conversations={conversations}
            activeConversationId={activeConversationId}
            runningConversationIds={runningConversationIds}
            activePage={activePage}
            i18n={i18n}
            onNewChat={handleNewChat}
            onSelectConversation={handleSelectConversation}
            onDeleteConversation={handleDeleteConversation}
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
                onBranch={(id) => { setActiveConversationId(id); void refreshConversations(); }}
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
