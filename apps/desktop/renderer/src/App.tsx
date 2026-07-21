import { createI18n } from '@peer-agent/i18n';
import type { LlmProviderConfigView } from '@peer-agent/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SettingsPage } from './app/components/SettingsPage';
import { BrandStartupLoader } from './app/components/BrandStartupLoader';
import { QuickChatWindow } from './app/components/QuickChatWindow';
import { displayShortcut } from './app/components/ShortcutsPanel';
import { useConfirm } from './app/components/ConfirmProvider';
import { shouldRefreshQuickChatConversationList } from './app/state/quickChatSubmission';
import { CONVERSATION_LIST_PAGE_SIZE, useDesktopBootstrap } from './app/state/useDesktopBootstrap';
import { useBrandStartupMinHold } from './app/state/useBrandStartupMinHold';
import { ChatSurface } from './chat/components/ChatSurface';
import { Sidebar } from './chat/components/Sidebar';
import { ConversationSearchPalette, type SearchConversationHit } from './chat/components/ConversationSearchPalette';
import { conversationStore } from './chat/state/conversationStore';
import {
  clearCompletedUnreadId,
  nextCompletedUnreadIds,
  sameStringSet,
} from './chat/state/completedUnreadState';
import { readGitBranchPrefixFromSettings } from './app/gitBranchPrefix';
import type { CompactionState } from './chat/state/types';
import { clientApi } from './clientApi';
import { WorkbenchPanel } from './workbench/WorkbenchPanel';
import { WorkbenchProvider } from './workbench/WorkbenchContext';

const DEFAULT_NEW_TASK_SHORTCUT = 'CommandOrControl+N';

function eventMatchesAccelerator(event: KeyboardEvent, accelerator: string): boolean {
  const parts = accelerator.split('+').filter(Boolean);
  if (parts.length < 2) return false;
  const keyPart = parts[parts.length - 1]!;
  const modifiers = new Set(parts.slice(0, -1));
  const wantsMeta = modifiers.has('Command') || modifiers.has('Cmd') || modifiers.has('CommandOrControl') || modifiers.has('CmdOrCtrl') || modifiers.has('Super') || modifiers.has('Meta');
  const wantsCtrl = modifiers.has('Control') || modifiers.has('Ctrl') || modifiers.has('CommandOrControl') || modifiers.has('CmdOrCtrl');
  const wantsAlt = modifiers.has('Alt') || modifiers.has('Option');
  const wantsShift = modifiers.has('Shift');
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key === ' ' ? 'Space' : event.key;
  if (key !== keyPart && key.toLowerCase() !== keyPart.toLowerCase()) return false;
  if (wantsAlt !== event.altKey) return false;
  if (wantsShift !== event.shiftKey) return false;
  if (modifiers.has('CommandOrControl') || modifiers.has('CmdOrCtrl')) {
    if (!(event.metaKey || event.ctrlKey)) return false;
  } else {
    if (wantsMeta !== event.metaKey) return false;
    if (wantsCtrl !== event.ctrlKey) return false;
  }
  return true;
}

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
  pinnedAt?: string | null;
  pinnedOrder?: number | null;
}

function readSystemInstructions(settings: Record<string, unknown> | null | undefined): string {
  return typeof settings?.systemInstructions === 'string' ? settings.systemInstructions : '';
}

function readReplyLanguage(settings: Record<string, unknown> | null | undefined): string {
  return typeof settings?.replyLanguage === 'string' ? settings.replyLanguage : '';
}

function readGitBranchPrefix(settings: Record<string, unknown> | null | undefined): string {
  return readGitBranchPrefixFromSettings(settings);
}

export function App() {
  const windowView = new URLSearchParams(window.location.search).get('window');
  if (windowView === 'quick-chat') return <QuickChatWindow />;

  return <MainApp />;
}

function MainApp() {
  const { availableLocales, initError, refreshBootstrap, session, startupSnapshot } = useDesktopBootstrap();
  // LOGO 过渡页保留：bootstrap 再快也要播完品牌入场动画，再进入主界面。
  const brandStartupHoldDone = useBrandStartupMinHold(!initError);
  const showMainShell = Boolean(session) && brandStartupHoldDone;
  const confirm = useConfirm();
  const i18n = useMemo(() => createI18n(session?.locale), [session?.locale]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [activePage, setActivePage] = useState<AppPage>('chat');
  const [conversationView, setConversationView] = useState<ConversationView>('active');
  // 窗口是否处于原生全屏。全屏时交通灯被系统隐藏,据此收掉顶部为其预留的留白。
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [providers, setProviders] = useState<readonly LlmProviderConfigView[]>([]);
  const [conversations, setConversations] = useState<readonly ConversationMeta[]>(
    () => startupSnapshot?.conversations as readonly ConversationMeta[] ?? [],
  );
  const [conversationNextCursor, setConversationNextCursor] = useState<string | null>(
    () => startupSnapshot?.conversationNextCursor ?? null,
  );
  const [conversationHasMore, setConversationHasMore] = useState<boolean>(
    () => Boolean(startupSnapshot?.conversationHasMore),
  );
  const [conversationsLoadingMore, setConversationsLoadingMore] = useState(false);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [conversationRevision, setConversationRevision] = useState<string | null>(null);
  // 表达层状态:当前正在流式运行的会话 id 集合,用于左侧列表显示 Loading 图标。
  // 真值来自 main 的 activeStreams:挂载时经 chatStreamListActive 拉取,之后由
  // onChatActiveStreamsChanged 广播实时更新——因此无需"点进会话"即可显示运行状态。
  // 另外 ChatSurface 的 onStreamingChange 作为本会话的即时信号合并进集合(更快反馈)。
  const [runningConversationIds, setRunningConversationIds] = useState<ReadonlySet<string>>(
    () => new Set());
  // 表达层状态:任务完成后尚未打开查看的会话。会话内内存态,不跨重启持久化。
  // 置位:会话离开 running 且当前不是 active;清除:用户打开/选中该会话。
  const [completedUnreadConversationIds, setCompletedUnreadConversationIds] = useState<ReadonlySet<string>>(
    () => new Set());
  const runningConversationIdsRef = useRef<ReadonlySet<string>>(new Set());
  const activeConversationIdRef = useRef<string | null>(null);
  // 所有敏感操作确认均来自 conversationStore 的受治理 pendingPermissionCalls。
  // 在 App 层按会话投影给 Sidebar，列表不解析模型文本，也不复制审批事实。
  const [pendingConfirmationCounts, setPendingConfirmationCounts] = useState<ReadonlyMap<string, number>>(
    () => new Map());
  // 表达层状态:当前正在执行上下文压缩的会话 -> 显式压缩状态机。
  // 由 conversationStore 按侧栏会话订阅派生,避免切换 tab/会话后依赖已卸载 ChatSurface 上报而停止刷新。
  const [compactionStates, setCompactionStates] = useState<ReadonlyMap<string, CompactionState>>(
    () => new Map());
  // ADR 27: 有运行中流的工作区路径集合,由活跃流投影的 streams 维度派生。
  // 让侧栏能提示"其它工作区仍有任务在跑",避免切换工作区后误以为任务丢失。
  const [runningWorkspacePaths, setRunningWorkspacePaths] = useState<ReadonlySet<string>>(
    () => new Set());
  const [activeWorkspace, setActiveWorkspace] = useState<string | null>(() => startupSnapshot?.activeWorkspace ?? null);
  // ADR 21: main 进程可能已写入 PendingTask(例如重启恢复)。renderer 只负责
  // 切到 task.sessionId(回到中断现场)后,把 task 下发给 ChatSurface 自动发出。
  const [resumeTask, setResumeTask] = useState<{ sessionId: string; task: string; effort?: string } | null>(null);
  const [systemInstructions, setSystemInstructions] = useState(() =>
    readSystemInstructions(clientApi.initialSettings));
  const [replyLanguage, setReplyLanguage] = useState(() =>
    readReplyLanguage(clientApi.initialSettings));
  const [gitBranchPrefix, setGitBranchPrefix] = useState(() =>
    readGitBranchPrefix(clientApi.initialSettings));

  const refreshProviders = useCallback(async () => {
    // 表达层只展示用户明确配置的模型。远程/本机目录是设置页的候选来源，不能在聊天菜单里
    // 自动展开，否则“支持的模型”会绕过配置边界，串进 provider 的已配置模型列表。
    try { setProviders(await clientApi.llmListProviders()); } catch {}
  }, []);

  const refreshSeqRef = useRef(0);
  const conversationRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyConversationListPage = useCallback((page: {
    items?: readonly ConversationMeta[];
    nextCursor?: string | null;
    hasMore?: boolean;
  } | readonly ConversationMeta[], { append = false }: { append?: boolean } = {}) => {
    const normalized = Array.isArray(page)
      ? { items: page as readonly ConversationMeta[], nextCursor: null, hasMore: false }
      : (() => {
          const nextCursor = page.nextCursor ?? null;
          // hasMore 仅在同时具备 nextCursor 时成立，避免刷新后残留误显。
          const hasMore = Boolean(page.hasMore) && Boolean(nextCursor);
          return {
            items: (page.items ?? []) as readonly ConversationMeta[],
            nextCursor,
            hasMore,
          };
        })();
    setConversations((prev) => {
      if (!append) return normalized.items;
      const seen = new Set(prev.map((item) => item.id));
      const merged = [...prev];
      for (const item of normalized.items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        merged.push(item);
      }
      return merged;
    });
    setConversationNextCursor(normalized.nextCursor);
    setConversationHasMore(normalized.hasMore);
  }, []);

  const refreshConversations = useCallback(async (wsPath?: string | null, view?: ConversationView) => {
    const ws = wsPath !== undefined ? wsPath : activeWorkspace;
    const status = view ?? conversationView;
    const seq = ++refreshSeqRef.current;
    try {
      const page = await clientApi.conversationsList({
        workspacePath: ws,
        status,
        limit: CONVERSATION_LIST_PAGE_SIZE,
        paginated: true,
      });
      // 丢弃过期响应：只有最新一次请求的结果才允许写回，避免慢请求晚返回覆盖新视图。
      if (seq !== refreshSeqRef.current) return;
      applyConversationListPage(page as any, { append: false });
    } catch {}
  }, [activeWorkspace, applyConversationListPage, conversationView]);

  const loadMoreConversations = useCallback(async () => {
    if (!conversationHasMore || conversationsLoadingMore || !conversationNextCursor) return;
    const ws = activeWorkspace;
    const status = conversationView;
    const seq = refreshSeqRef.current;
    setConversationsLoadingMore(true);
    try {
      const page = await clientApi.conversationsList({
        workspacePath: ws,
        status,
        limit: CONVERSATION_LIST_PAGE_SIZE,
        cursor: conversationNextCursor,
        paginated: true,
      });
      if (seq !== refreshSeqRef.current) return;
      applyConversationListPage(page as any, { append: true });
    } catch {
    } finally {
      setConversationsLoadingMore(false);
    }
  }, [
    activeWorkspace,
    applyConversationListPage,
    conversationHasMore,
    conversationNextCursor,
    conversationView,
    conversationsLoadingMore,
  ]);

  const scheduleConversationRefresh = useCallback((wsPath?: string | null, view?: ConversationView) => {
    if (conversationRefreshTimerRef.current) clearTimeout(conversationRefreshTimerRef.current);
    conversationRefreshTimerRef.current = setTimeout(() => {
      conversationRefreshTimerRef.current = null;
      void refreshConversations(wsPath, view);
    }, 120);
  }, [refreshConversations]);

  useEffect(() => {
    const refreshExternalConversations = () => {
      if (document.visibilityState === 'visible') scheduleConversationRefresh();
    };
    window.addEventListener('focus', refreshExternalConversations);
    document.addEventListener('visibilitychange', refreshExternalConversations);
    const unsubscribe = clientApi.onConversationsChanged(() => {
      // 变更事件目前只有 conversationId/changeType，缺少单行完整 meta；
      // 统一防抖重拉第一页，避免 focus/高频变更触发整表全量。
      scheduleConversationRefresh();
    });
    return () => {
      window.removeEventListener('focus', refreshExternalConversations);
      document.removeEventListener('visibilitychange', refreshExternalConversations);
      if (conversationRefreshTimerRef.current) clearTimeout(conversationRefreshTimerRef.current);
      unsubscribe();
    };
  }, [scheduleConversationRefresh]);

  const refreshSettings = useCallback(async () => {
    try {
      const settings = await clientApi.getSettings();
      setSystemInstructions(readSystemInstructions(settings));
      setReplyLanguage(readReplyLanguage(settings));
      setGitBranchPrefix(readGitBranchPrefix(settings));
    } catch {}
  }, []);

  useEffect(() => clientApi.onQuickChatConversationCreated(({ workspacePath }) => {
    if (shouldRefreshQuickChatConversationList(workspacePath, activeWorkspace)) {
      void refreshConversations(workspacePath, conversationView);
    }
  }), [activeWorkspace, conversationView, refreshConversations]);

  useEffect(() => {
    return clientApi.onQuickChatOpenConversation(({ conversationId, workspacePath }) => {
      void (async () => {
        await clientApi.workspaceSetActive({ path: workspacePath });
        setActiveWorkspace(workspacePath);
        await refreshConversations(workspacePath, conversationView);
        setActiveConversationId(conversationId);
      })().catch(() => {});
    });
  }, [conversationView, refreshConversations]);

  useEffect(() => {
    void refreshProviders();
    void refreshSettings();
    if (startupSnapshot) return;
    void clientApi.workspaceList().then(async (r) => {
      setActiveWorkspace(r.activeWorkspace);
      try {
        const list = await clientApi.conversationsList({ workspacePath: r.activeWorkspace, status: 'active' });
        setConversations(list as readonly ConversationMeta[]);
      } catch {
        // Keep the workspace interactive when startup preloading and fallback refresh both fail.
      }
    }).catch(() => undefined);
  }, [refreshProviders, refreshSettings, startupSnapshot]);

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

  // 同步 activeConversationId ref,并在用户打开会话时清除完成未读标记。
  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
    if (!activeConversationId) return;
    setCompletedUnreadConversationIds((prev) => {
      const next = clearCompletedUnreadId(prev, activeConversationId);
      return sameStringSet(prev, next) ? prev : next;
    });
  }, [activeConversationId]);

  // 统一写入 runningConversationIds:顺带根据 prev→next 差分置位完成未读。
  const applyRunningConversationIds = useCallback((nextIds: ReadonlySet<string>) => {
    const previousIds = runningConversationIdsRef.current;
    if (sameStringSet(previousIds, nextIds)) return;
    runningConversationIdsRef.current = nextIds;
    setRunningConversationIds(nextIds);
    setCompletedUnreadConversationIds((unread) => {
      const derived = nextCompletedUnreadIds({
        previousRunningIds: previousIds,
        nextRunningIds: nextIds,
        activeConversationId: activeConversationIdRef.current,
        completedUnreadIds: unread,
      });
      return sameStringSet(unread, derived) ? unread : derived;
    });
  }, []);

  // 全局运行中会话:挂载时拉取当前活跃流快照,并订阅后续变更广播。
  // 这让左侧列表无需"点进去"即可知道哪些会话正在跑(含后台并行会话)。
  useEffect(() => {
    // ADR 27: streams 携带发起工作区(origin),据此派生"哪些工作区有运行中的流"。
    // Goal target/execution 不进入绿点;优先 originWorkspacePath,兼容旧投影的 workspacePath。
    const applyStreams = (
      conversationIds: readonly string[],
      streams: readonly {
        conversationId: string;
        workspacePath: string | null;
        originWorkspacePath?: string | null;
      }[],
    ) => {
      applyRunningConversationIds(new Set(conversationIds));
      const wsPaths = new Set<string>();
      for (const s of streams) {
        const origin = s.originWorkspacePath ?? s.workspacePath;
        if (origin) wsPaths.add(origin);
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
  }, [applyRunningConversationIds]);

  useEffect(() => {
    const conversationIds = Array.from(new Set(conversations.map((conversation) => conversation.id)));
    const syncCompactionStates = () => {
      const next = new Map<string, CompactionState>();
      for (const conversationId of conversationIds) {
        const snapshot = conversationStore.getSnapshot(conversationId);
        if (snapshot.compactionState.phase !== 'idle') {
          next.set(conversationId, snapshot.compactionState);
        }
      }
      setCompactionStates((prev) => {
        if (prev.size === next.size) {
          let unchanged = true;
          for (const [conversationId, state] of next) {
            if (prev.get(conversationId) !== state) {
              unchanged = false;
              break;
            }
          }
          if (unchanged) return prev;
        }
        return next;
      });
    };

    syncCompactionStates();
    const unsubs = conversationIds.map((conversationId) =>
      conversationStore.subscribeSelector(
        conversationId,
        (state) => state.compactionState,
        syncCompactionStates,
      ),
    );
    return () => { unsubs.forEach((unsub) => unsub()); };
  }, [conversations]);

  useEffect(() => {
    const conversationIds = conversations.map((conversation) => conversation.id);
    const syncPendingConfirmations = () => {
      const next = new Map<string, number>();
      for (const conversationId of conversationIds) {
        const count = conversationStore.getSnapshot(conversationId).pendingPermissionCalls.length;
        if (count > 0) next.set(conversationId, count);
      }
      setPendingConfirmationCounts((previous) => {
        if (previous.size === next.size && [...next].every(([id, count]) => previous.get(id) === count)) {
          return previous;
        }
        return next;
      });
    };

    syncPendingConfirmations();
    const unsubs = conversationIds.map((conversationId) =>
      conversationStore.subscribeSelector(
        conversationId,
        (state) => state.pendingPermissionCalls.length,
        syncPendingConfirmations,
      ),
    );
    return () => { unsubs.forEach((unsub) => unsub()); };
  }, [conversations]);

  const handleWorkspaceChanged = useCallback(async () => {
    const r = await clientApi.workspaceList();
    setActiveWorkspace(r.activeWorkspace);
    setConversationView('active');
    // 切换工作区后自动选激活会话:优先第一个"进行中"的会话,否则第一个会话,
    // 空工作区(无任何会话)则保持空态。需 list 返回值当场计算,故内联拉取而非走
    // refreshConversations(后者只 setState、不回传列表)。
    let list: readonly ConversationMeta[] = [];
    try {
      list = await clientApi.conversationsList({ workspacePath: r.activeWorkspace, status: 'active' }) as readonly ConversationMeta[];
    } catch {}
    setConversations(list);
    const firstRunning = list.find((c) => runningConversationIds.has(c.id));
    const next = firstRunning ?? list[0] ?? null;
    setActiveConversationId(next ? next.id : null);
  }, [runningConversationIds]);



  const [newTaskShortcut, setNewTaskShortcut] = useState(DEFAULT_NEW_TASK_SHORTCUT);

  const refreshNewTaskShortcut = useCallback(async () => {
    try {
      const status = await clientApi.getShortcutStatus();
      const configured = status?.newTask?.configured;
      if (typeof configured === 'string' && configured.trim()) {
        setNewTaskShortcut(configured);
      } else {
        setNewTaskShortcut(DEFAULT_NEW_TASK_SHORTCUT);
      }
    } catch {
      setNewTaskShortcut(DEFAULT_NEW_TASK_SHORTCUT);
    }
  }, []);

  useEffect(() => {
    void refreshNewTaskShortcut();
  }, [refreshNewTaskShortcut]);

  const handleOpenSearch = useCallback(() => {
    setSearchOpen(true);
  }, []);

  const handleCloseSearch = useCallback(() => {
    setSearchOpen(false);
  }, []);

  const handleSearchSelectConversation = useCallback(async (hit: SearchConversationHit) => {
    const targetWorkspace = hit.workspacePath || null;
    const currentWorkspace = activeWorkspace || null;
    if (targetWorkspace && targetWorkspace !== currentWorkspace) {
      await clientApi.workspaceSetActive({ path: targetWorkspace });
      setActiveWorkspace(targetWorkspace);
      setConversationView('active');
      await refreshConversations(targetWorkspace, 'active');
    } else if (conversationView !== 'active') {
      setConversationView('active');
      await refreshConversations(activeWorkspace, 'active');
    }
    setActiveConversationId(hit.id);
    setActivePage('chat');
  }, [activeWorkspace, conversationView, refreshConversations]);

  const handleNewChat = useCallback(async () => {
    // 没有工作区时不允许把对话落到根目录:先确保有一个工作区(必要时默认初始化)。
    let ws = activeWorkspace;
    if (!ws) {
      const ensured = await clientApi.workspaceEnsureDefault();
      ws = ensured.path;
      setActiveWorkspace(ws);
    }
    // 草稿态：不落库、不进左侧列表；首条消息发送时再 create。
    // 已在草稿态时再次点击：保留输入框内容，仅确保停留在草稿。
    setConversationView('active');
    setActiveConversationId(null);
    setActivePage('chat');
  }, [activeWorkspace]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const key = event.key.toLowerCase();
      // ⌘K / Ctrl+K toggles Search Chats palette.
      if ((event.metaKey && key === 'k') || (event.ctrlKey && key === 'k')) {
        event.preventDefault();
        setSearchOpen((open) => !open);
        return;
      }
      // Configurable app-local "new task" shortcut (default ⌘/Ctrl+N).
      // Match ⌘K: fire even when focus is in composer/input fields.
      if (eventMatchesAccelerator(event, newTaskShortcut)) {
        event.preventDefault();
        void handleNewChat();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleNewChat, newTaskShortcut]);

  // 草稿态发首条消息时由 ChatSurface 调用：此时才创建会话并进入左侧列表。
  const ensureConversation = useCallback(async (seed?: {
    title?: string;
    mode?: string;
    effort?: string;
    modelProviderId?: string | null;
  }): Promise<{ id: string }> => {
    let ws = activeWorkspace;
    if (!ws) {
      const ensured = await clientApi.workspaceEnsureDefault();
      ws = ensured.path;
      setActiveWorkspace(ws);
    }
    const conv = await clientApi.conversationsCreate({
      workspacePath: ws,
      title: seed?.title,
      mode: seed?.mode,
    }) as ConversationMeta;
    // 在切到新会话前写回草稿态选中的模型/思考强度，避免 load 读到默认值。
    if (seed?.effort !== undefined || seed?.modelProviderId !== undefined) {
      await clientApi.conversationsUpdateModelEffort({
        id: conv.id,
        effort: seed?.effort,
        modelProviderId: seed?.modelProviderId,
      });
    }
    setConversationView('active');
    await refreshConversations(ws, 'active');
    setActiveConversationId(conv.id);
    setActivePage('chat');
    return { id: conv.id };
  }, [activeWorkspace, refreshConversations]);

  const handleSelectConversation = useCallback((id: string) => {
    setActiveConversationId(id);
    setActivePage('chat');
  }, []);

  const handleShowActiveConversations = useCallback(async () => {
    setConversationView('active');
    setActiveConversationId(null);
    setActivePage('chat');
    // 保留旧列表直到新数据成功返回，避免切换期间闪现"暂无会话"。
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
    const target = conversations.find((item) => item.id === id);
    const title = target?.title?.trim() || i18n.t('chat.conversations.untitled');
    const ok = await confirm({
      title: i18n.t('settings.archived.deleteTitle'),
      message: i18n.t('settings.archived.confirmDelete', { title }),
      confirmText: i18n.t('settings.archived.delete'),
      tone: 'danger',
    });
    if (!ok) return;

    await clientApi.conversationsDelete({ id });
    if (activeConversationId === id) setActiveConversationId(null);
    await refreshConversations(activeWorkspace, conversationView);
  }, [
    activeConversationId,
    activeWorkspace,
    confirm,
    conversations,
    conversationView,
    i18n,
    refreshConversations,
  ]);

  const handlePinConversation = useCallback(async (id: string) => {
    await clientApi.conversationsPin({ id });
    await refreshConversations(activeWorkspace, conversationView);
  }, [activeWorkspace, conversationView, refreshConversations]);

  const handleUnpinConversation = useCallback(async (id: string) => {
    await clientApi.conversationsUnpin({ id });
    await refreshConversations(activeWorkspace, conversationView);
  }, [activeWorkspace, conversationView, refreshConversations]);

  const handleReorderPinnedConversations = useCallback(async (ids: readonly string[]) => {
    await clientApi.conversationsReorderPinned({ ids });
    await refreshConversations(activeWorkspace, conversationView);
  }, [activeWorkspace, conversationView, refreshConversations]);

  const handleRenameConversation = useCallback(async (id: string, title: string) => {
    await clientApi.conversationsUpdateTitle({ id, title: title.trim() });
    await refreshConversations(activeWorkspace, conversationView);
  }, [activeWorkspace, conversationView, refreshConversations]);

  const isZh = (session?.locale ?? '').toLowerCase().startsWith('zh');

  return (
    <main className={isFullscreen ? 'app-shell is-fullscreen' : 'app-shell'}>
      {showMainShell ? (
        <>
          <section
            className={`app-page-layer app-chat-page${activePage === 'chat' ? ' is-active' : ''}`}
            aria-hidden={activePage !== 'chat'}
            inert={activePage !== 'chat'}
          >
            <WorkbenchProvider
              conversationId={activeConversationId}
              isPageActive={activePage === 'chat'}
            >
              <div className="app-layout">
            <Sidebar
              conversations={conversations}
              conversationHasMore={conversationHasMore}
              conversationNextCursor={conversationNextCursor}
              conversationsLoadingMore={conversationsLoadingMore}
              onLoadMoreConversations={() => { void loadMoreConversations(); }}
              activeConversationId={activeConversationId}
              conversationView={conversationView}
              runningConversationIds={runningConversationIds}
              completedUnreadConversationIds={completedUnreadConversationIds}
              compactionStates={compactionStates}
              pendingConfirmationCounts={pendingConfirmationCounts}
              runningWorkspacePaths={runningWorkspacePaths}
              activePage={activePage}
              i18n={i18n}
              onNewChat={handleNewChat}
              newTaskShortcutLabel={displayShortcut(newTaskShortcut)}
              onOpenSearch={handleOpenSearch}
              onSelectConversation={handleSelectConversation}
              onRenameConversation={handleRenameConversation}
              onArchiveConversation={handleArchiveConversation}
              onRestoreConversation={handleRestoreConversation}
              onDeleteConversation={handleDeleteConversation}
              onPinConversation={handlePinConversation}
              onUnpinConversation={handleUnpinConversation}
              onReorderPinnedConversations={handleReorderPinnedConversations}
              onShowActiveConversations={handleShowActiveConversations}
              onOpenSettings={() => setActivePage('settings')}
              onWorkspaceChanged={handleWorkspaceChanged}
              startupSnapshot={startupSnapshot}
            />
            <section className="main-panel">
              <section className="thread thread-has-header">
                <ChatSurface
                  i18n={i18n}
                  providers={providers}
                  conversationId={activeConversationId}
                  conversationRevision={conversationRevision}
                  conversationTitle={conversations.find((c) => c.id === activeConversationId)?.title}
                  systemInstructions={systemInstructions}
                  replyLanguage={replyLanguage}
                  gitBranchPrefix={gitBranchPrefix}
                  resumeTask={resumeTask}
                  onResumeConsumed={() => {
                    setResumeTask(null);
                    void clientApi.clearPendingTask().catch(() => {});
                  }}
                  onOpenSettings={() => setActivePage('settings')}
                  onConversationUpdated={() => { void refreshConversations(); }}
                  onStreamingChange={(convId, streaming) => {
                    if (!convId) return;
                    const prev = runningConversationIdsRef.current;
                    const has = prev.has(convId);
                    if (streaming === has) return;
                    const next = new Set(prev);
                    if (streaming) next.add(convId);
                    else next.delete(convId);
                    applyRunningConversationIds(next);
                  }}
                  onBranch={(id) => { setConversationView('active'); setActiveConversationId(id); void refreshConversations(activeWorkspace, 'active'); }}
                  onEnsureConversation={ensureConversation}
                  onRenameConversation={handleRenameConversation}
                  onArchiveConversation={handleArchiveConversation}
                  workspacePath={activeWorkspace}
                  isPageActive={activePage === 'chat'}
                />
              </section>
            </section>
                <WorkbenchPanel isZh={isZh} workspacePath={activeWorkspace} />
              </div>
            </WorkbenchProvider>
          </section>
          {activePage === 'settings' ? (
            <section className="app-page-layer app-settings-page is-active">
              <SettingsPage
                availableLocales={availableLocales}
                i18n={i18n}
                onBack={() => {
                  setActivePage('chat');
                  void refreshProviders();
                  void refreshSettings();
                  void refreshNewTaskShortcut();
                }}
                onLocaleChanged={refreshBootstrap}
                onReplyLanguageChanged={setReplyLanguage}
                onSystemInstructionsChanged={setSystemInstructions}
                onGitBranchPrefixChanged={setGitBranchPrefix}
                workspacePath={activeWorkspace}
                onArchivedConversationsChanged={() => refreshConversations(activeWorkspace, conversationView)}
              />
            </section>
          ) : null}

      {searchOpen ? (
        <ConversationSearchPalette
          open={searchOpen}
          i18n={i18n}
          activeWorkspace={activeWorkspace}
          onClose={handleCloseSearch}
          onSelectConversation={handleSearchSelectConversation}
          onNewTask={async () => {
            setSearchOpen(false);
            await handleNewChat();
          }}
        />
      ) : null}
        </>
      ) : (
        <section className="main-panel">
          <section className="thread">
            {initError ? <p className="running-note">{initError}</p> : null}
            {!initError ? <BrandStartupLoader /> : null}
          </section>
        </section>
      )}
    </main>
  );
}
