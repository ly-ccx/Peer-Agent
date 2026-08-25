import { createI18n } from '@peer-agent/i18n';
import type { AcceptanceCloseVerdict, LlmProviderConfigView } from '@peer-agent/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SettingsPage, type SettingsSection } from './app/components/SettingsPage';
import { CapabilitiesPanel } from './app/components/CapabilitiesPanel';
import { Drawer } from './app/components/Drawer';
import { ConversationResultView } from './app/components/ConversationResultView';
import { continueTaskInConversation } from './app/taskContinuation';
import { resolveTaskRelatedMessageId } from './chat/state/taskRelatedMessageResolve';
import { HomePage } from './app/pages/HomePage';
import { GlobalWorkbenchPage } from './app/pages/GlobalWorkbenchPage';
import { TasksPage } from './app/pages/TasksPage';
import { HistoryPage } from './app/pages/HistoryPage';
import type { TaskOverviewItem } from '@peer-agent/protocol';
import {
  resolveResultDrawerAcceptanceTargets,
  type OpenResultOptions,
} from './app/state/resultDrawerAcceptance';
import { AutomationCenter } from './automations/AutomationCenter';
import { getAutomationCopy } from './automations/automationI18n';
import { BrandStartupLoader } from './app/components/BrandStartupLoader';
import { FullDiskAccessStartupGate } from './app/components/FullDiskAccessStartupGate';
import { QuickChatPopoverHost } from './app/components/QuickChatPopoverHost';
import { QuickChatWindow } from './app/components/QuickChatWindow';
import { displayShortcut } from './app/components/ShortcutsPanel';
import { useConfirm } from './app/components/ConfirmProvider';
import {
  navigateToQuickChatConversation,
  shouldRefreshQuickChatConversationList,
} from './app/state/quickChatSubmission';
import { CONVERSATION_LIST_PAGE_SIZE, useDesktopBootstrap } from './app/state/useDesktopBootstrap';
import { useBrandStartupMinHold } from './app/state/useBrandStartupMinHold';
import { ChatSurface } from './chat/components/ChatSurface';
import { useConversationStreamRouter } from './chat/hooks/useConversationStreamRouter';
import { Sidebar } from './chat/components/Sidebar';
import { ConversationSearchPalette, type SearchConversationHit } from './chat/components/ConversationSearchPalette';
import { conversationStore } from './chat/state/conversationStore';
import { normalizeConversationListPage } from './chat/state/conversationListPagination';
import {
  clearCompletedUnreadId,
  nextCompletedUnreadIds,
  sameStringSet,
} from './chat/state/completedUnreadState';
import {
  applyLocalStreamingWorkspaceChange,
  deriveRunningWorkspacePaths,
} from './chat/state/runningWorkspaceState';
import { readGitBranchPrefixFromSettings } from './app/gitBranchPrefix';
import type { CompactionState } from './chat/state/types';
import { registeredWorkspacePath } from './chat/state/registeredWorkspace';
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

type AppPage = 'chat' | 'home' | 'automations' | 'tools' | 'settings';
/** 任务/历史/会话不再作为一级全屏页，改为 Drawer 承载。 */
type CollectionDrawer = 'tasks' | 'history' | 'result' | null;
type ConversationStatus = 'active' | 'archived';
type ConversationView = 'active' | 'archived';

interface ConversationMeta {
  id: string;
  title: string;
  workspacePath?: string | null;
  messageCount: number;
  updatedAt: string;
  status?: ConversationStatus;
  archivedAt?: string | null;
  pinnedAt?: string | null;
  pinnedOrder?: number | null;
  /** Durable automation Fresh Run origin; rename-safe badge signal. */
  automationOrigin?: {
    kind: 'automation_run';
    automationId: string;
    runId: string;
    automationName?: string;
    triggerSource?: string;
    createdAt?: string;
  } | null;
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
  if (windowView === 'quick-chat-popover') return <QuickChatPopoverHost />;

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
  /** 工作台数据范围：顶部入口=全部；下方工作区入口=当前区。 */
  const [homeScope, setHomeScope] = useState<'all' | 'workspace'>('all');
  const [collectionDrawer, setCollectionDrawer] = useState<CollectionDrawer>(null);
  /** 二级会话 Drawer 独立于一级结果 Drawer，避免“继续讨论”替换并卸载父级。 */
  const [conversationDrawerOpen, setConversationDrawerOpen] = useState(false);
  const [resultDrawerItem, setResultDrawerItem] = useState<TaskOverviewItem | null>(null);
  const [resultDrawerAcceptTogether, setResultDrawerAcceptTogether] = useState<readonly TaskOverviewItem[]>([]);
  const [resultAcceptancePending, setResultAcceptancePending] = useState<TaskOverviewItem | null>(null);
  const [resultCloseGate, setResultCloseGate] = useState<AcceptanceCloseVerdict | null>(null);
  /** 证据不全时用户二次确认强制归档，供关闭动画后的 revise 写入 userOverride。 */
  const resultAcceptanceUserOverrideRef = useRef(false);
  /** 抽屉验收关完后走工作台 handleAccept，只播那条记录的卡片粉碎。 */
  const workbenchAcceptRef = useRef<((item: TaskOverviewItem) => void | Promise<void>) | null>(null);

  const openCollectionDrawer = useCallback((kind: Exclude<CollectionDrawer, null>) => {
    setCollectionDrawer(kind);
  }, []);

  const openResultDrawer = useCallback((item: TaskOverviewItem, options?: OpenResultOptions) => {
    setResultDrawerItem(item);
    setResultDrawerAcceptTogether(options?.acceptTogether ?? []);
    setCollectionDrawer('result');
    setResultAcceptancePending(null);
    setResultCloseGate(null);
    if (item.conversationId) setActiveConversationId(item.conversationId);
  }, []);

  const closeResultDrawer = useCallback(() => {
    setConversationDrawerOpen(false);
    setCollectionDrawer(null);
    setResultDrawerItem(null);
    setResultDrawerAcceptTogether([]);
  }, []);

  const acceptResultFromWorkbench = useCallback(async (
    item: TaskOverviewItem,
    options?: { readonly userOverride?: boolean },
  ) => {
    if (item.source !== 'goal_plan' || !item.taskId) return;
    const userOverride = options?.userOverride === true || resultAcceptanceUserOverrideRef.current;
    try {
      await clientApi.goalPlansRevise({
        planId: item.taskId,
        patch: {
          resultAcceptance: {
            acceptedAt: new Date().toISOString(),
            acceptedBy: 'user',
            ...(userOverride ? { userOverride: true } : {}),
          },
        },
        reason: userOverride ? 'workbench_force_accept' : 'workbench_one_click_accept',
        changedBy: 'user',
      });
      setResultDrawerItem((current) => (current?.taskId === item.taskId ? null : current));
      setResultDrawerAcceptTogether((currentTogether) => (
        currentTogether.some((entry) => entry.taskId === item.taskId) ? [] : currentTogether
      ));
      setCollectionDrawer((current) => (current === 'result' ? null : current));
    } catch (error) {
      console.error('[workbench] accept result failed', error);
      throw error;
    } finally {
      if (userOverride) resultAcceptanceUserOverrideRef.current = false;
    }
  }, []);

  const cancelPlanFromWorkbench = useCallback(async (item: TaskOverviewItem) => {
    if (item.source !== 'goal_plan' || !item.taskId) return;
    // 使用产品 ConfirmProvider（Peer Frost Modal），禁止 window.confirm 原生弹窗。
    const zh = (session?.locale ?? '').toLowerCase().startsWith('zh');
    const ok = await confirm({
      title: zh ? '取消推进中的任务' : 'Cancel advancing task',
      message: zh
        ? `确定取消「${item.title}」？取消后将进入历史，Peer 不再推进。`
        : `Cancel “${item.title}”? It will move to history and Peer will stop advancing it.`,
      confirmText: zh ? '确认取消' : 'Cancel task',
      cancelText: zh ? '再想想' : 'Keep it',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      // 关键：必须走 goalRunnerClear，而不是只 setStatus('cancelled')。
      // clear 会：session.cancelled=true（停 pump/后续 tick）+ plan→cancelled + runner→idle。
      // 仅 setStatus 只会改展示状态，背后 runner/流式仍会继续跑。
      await clientApi.goalRunnerClear({ planId: item.taskId });
    } catch (error) {
      console.error('[workbench] cancel plan failed', error);
      // 兜底：即便 runner clear 失败，仍尽量把计划标成 cancelled，避免工作台假活。
      try {
        await clientApi.goalPlansSetStatus({
          planId: item.taskId,
          status: 'cancelled',
        });
      } catch (fallbackError) {
        console.error('[workbench] cancel plan status fallback failed', fallbackError);
      }
    }
    if (!item.deliveryRoute) return;
    const discard = await confirm({
      title: zh ? '删除这条线？' : 'Discard this line?',
      message: zh
        ? '推进已经停了。也可以继续删除隔离目录和未合入的任务分支；已合入的提交不会被抹掉。'
        : 'Advancing has stopped. You can also remove the isolated worktree and any unmerged task branch. Merged commits stay.',
      confirmText: zh ? '删除这条线' : 'Discard line',
      cancelText: zh ? '只停推进' : 'Stop only',
      tone: 'danger',
    });
    if (!discard) return;
    try {
      await clientApi.goalPlansDiscardLine({ planId: item.taskId, deleteBranch: true });
    } catch (error) {
      console.error('[workbench] discard line after cancel failed', error);
    }
  }, [confirm, session?.locale]);

  const closeCollectionDrawer = useCallback(() => {
    setCollectionDrawer(null);
    setResultDrawerItem(null);
    setResultDrawerAcceptTogether([]);
  }, []);
  const [automationRunTarget, setAutomationRunTarget] = useState<{ automationId: string; runId: string } | null>(null);
  const openAutomationRun = useCallback((target: { automationId: string; runId: string }) => {
    setCollectionDrawer(null);
    setAutomationRunTarget(target);
    setActivePage('automations');
  }, []);
  useEffect(() => clientApi.onAutomationOpenRun(openAutomationRun), [openAutomationRun]);
  const [settingsInitialSection, setSettingsInitialSection] = useState<SettingsSection>('general');
  const [conversationView, setConversationView] = useState<ConversationView>('active');
  // 窗口是否处于原生全屏。全屏时交通灯被系统隐藏,据此收掉顶部为其预留的留白。
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [providers, setProviders] = useState<readonly LlmProviderConfigView[]>([]);
  const [conversations, setConversations] = useState<readonly ConversationMeta[]>(
    () => startupSnapshot?.conversations as readonly ConversationMeta[] ?? [],
  );
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [notificationMessageTarget, setNotificationMessageTarget] = useState<{
    conversationId: string;
    messageId: string;
    requestId: number;
  } | null>(null);
  const notificationMessageRequestRef = useRef(0);
  const focusTaskRelatedMessage = useCallback((item: TaskOverviewItem) => {
    if (!item.conversationId) return;
    const conversationId = String(item.conversationId);
    void resolveTaskRelatedMessageId(item).then((messageId) => {
      if (!messageId) return;
      notificationMessageRequestRef.current += 1;
      setNotificationMessageTarget({
        conversationId,
        messageId,
        requestId: notificationMessageRequestRef.current,
      });
    });
  }, []);
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
  // Keep a ref so local onStreamingChange can update workspace dots without
  // reading a stale closure of the authoritative set.
  const runningWorkspacePathsRef = useRef<ReadonlySet<string>>(new Set());
  const [activeWorkspace, setActiveWorkspace] = useState<string | null>(() => startupSnapshot?.activeWorkspace ?? null);
  // A draft task may target a workspace without navigating the application there.
  // Keep that choice separate from the globally active workspace until submission.
  const [draftWorkspacePath, setDraftWorkspacePath] = useState<string | null>(
    () => registeredWorkspacePath(
      startupSnapshot?.activeWorkspace,
      startupSnapshot?.workspaces ?? [],
    ),
  );
  const [workspaces, setWorkspaces] = useState<readonly { path: string; name: string; baseBranch?: string }[]>(
    () => startupSnapshot?.workspaces ?? [],
  );
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
    try {
      setProviders(await clientApi.llmListProviders());
    } catch {
      // Keep previous providers on transient list failures.
    }
  }, []);

  const refreshSeqRef = useRef(0);
  const conversationRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyConversationListPage = useCallback((page: {
    items?: readonly ConversationMeta[];
    nextCursor?: string | null;
    hasMore?: boolean;
  } | readonly ConversationMeta[], { append = false }: { append?: boolean } = {}) => {
    const normalized = normalizeConversationListPage(page);
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
  }, []);

  const refreshConversations = useCallback(async (_wsPath?: string | null, view?: ConversationView) => {
    const status = view ?? conversationView;
    const seq = ++refreshSeqRef.current;
    try {
      const page = await clientApi.conversationsList({
        status,
        limit: CONVERSATION_LIST_PAGE_SIZE,
        paginated: true,
      });
      // 丢弃过期响应：只有最新一次请求的结果才允许写回，避免慢请求晚返回覆盖新视图。
      if (seq !== refreshSeqRef.current) return;
      applyConversationListPage(page as any, { append: false });
    } catch {}
  }, [applyConversationListPage, conversationView]);

  useConversationStreamRouter({
    activeConversationId,
    onConversationUpdated: () => {
      void refreshConversations();
    },
  });

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
    return clientApi.onQuickChatOpenConversation(({ conversationId, workspacePath, planId, messageId }) => {
      void (async () => {
        await navigateToQuickChatConversation(
          { conversationId, workspacePath },
          {
            openChatPage: () => {
              setCollectionDrawer(null);
              setActivePage('chat');
              setConversationView('active');
            },
            activateWorkspace: async (nextWorkspacePath) => {
              await clientApi.workspaceSetActive({ path: nextWorkspacePath });
              setActiveWorkspace(nextWorkspacePath);
            },
            refreshConversations: (nextWorkspacePath) => (
              refreshConversations(nextWorkspacePath, conversationView)
            ),
            selectConversation: setActiveConversationId,
          },
        );
        if (messageId) {
          notificationMessageRequestRef.current += 1;
          setNotificationMessageTarget({
            conversationId,
            messageId,
            requestId: notificationMessageRequestRef.current,
          });
        }
        // 点击系统通知回流时，若带 planId 则精确标记该任务 attention 已读。
        if (planId) {
          await clientApi
            .setActiveConversation({ conversationId, planId })
            .catch(() => {});
        }
      })().catch(() => {});
    });
  }, [conversationView, refreshConversations]);

  useEffect(() => {
    void refreshProviders();
    void refreshSettings();
    if (startupSnapshot) return;
    void clientApi.workspaceList().then(async (r) => {
      setWorkspaces(r.workspaces);
      setActiveWorkspace(r.activeWorkspace);
      try {
        const page = await clientApi.conversationsList({
          status: 'active',
          limit: CONVERSATION_LIST_PAGE_SIZE,
          paginated: true,
        });
        applyConversationListPage(page as Parameters<typeof applyConversationListPage>[0]);
      } catch {
        // Keep the workspace interactive when startup preloading and fallback refresh both fail.
      }
    }).catch(() => undefined);
  }, [applyConversationListPage, refreshProviders, refreshSettings, startupSnapshot]);

  const openSettings = useCallback((section: SettingsSection = 'general') => {
    setCollectionDrawer(null);
    setSettingsInitialSection(section);
    setActivePage('settings');
  }, []);
  // setupModelAutoOpened used to auto-open Settings once. First-run now stays
  // on the empty chat path and no longer uses that preference to steal focus.

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
        setCollectionDrawer(null);
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
  // 同时上报 main 进程，供任务系统通知做同会话前台抑制。
  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
    void clientApi.setActiveConversation({ conversationId: activeConversationId }).catch(() => {});
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

  const handleDrawerStreamingChange = useCallback((conversationId: string | null, isStreaming: boolean) => {
    if (!conversationId) return;
    const nextIds = new Set(runningConversationIdsRef.current);
    if (isStreaming) nextIds.add(conversationId);
    else nextIds.delete(conversationId);
    applyRunningConversationIds(nextIds);

    const nextWorkspacePaths = applyLocalStreamingWorkspaceChange({
      prev: runningWorkspacePathsRef.current,
      workspacePath: activeWorkspace,
      isStreaming,
      remainingRunningConversationCount: nextIds.size,
    });
    if (!sameStringSet(runningWorkspacePathsRef.current, nextWorkspacePaths)) {
      runningWorkspacePathsRef.current = nextWorkspacePaths;
      setRunningWorkspacePaths(nextWorkspacePaths);
    }
  }, [activeWorkspace, applyRunningConversationIds]);

  // 全局运行中会话:挂载时拉取当前活跃流快照,并订阅后续变更广播。
  // 这让左侧列表无需"点进去"即可知道哪些会话正在跑(含后台并行会话)。
  useEffect(() => {
    // ADR 27: streams 携带发起工作区(origin),据此派生"哪些工作区有运行中的流"。
    // Goal target/execution 不进入绿点;优先 originWorkspacePath,兼容旧投影的 workspacePath。
    const applyStreams = (
      conversationIds: readonly string[],
      streams: readonly {
        conversationId: string;
        streamId: string;
        workspacePath: string | null;
        originWorkspacePath?: string | null;
      }[],
    ) => {
      applyRunningConversationIds(new Set(conversationIds));
      // main 的活跃流投影是运行态真值。若终态 IPC 在 renderer 重载/路由切换时丢失，
      // 以仍然活跃的 streamId 集合兜底清理 conversationStore，且不会误结束其它会话。
      conversationStore.settleInactiveStreams(streams.map((stream) => stream.streamId));
      // Prefer originWorkspacePath (ADR 27). Normalize keys so trailing-slash
      // variants do not leave a sticky "other workspace" yellow/green dot.
      const wsPaths = deriveRunningWorkspacePaths(streams);
      runningWorkspacePathsRef.current = wsPaths;
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
    setWorkspaces(r.workspaces);
    setActiveWorkspace(r.activeWorkspace);
    setConversationView('active');
    // 任务树跨区展示：只刷新全量列表，不跳走、不抢走当前任务。
    await refreshConversations(undefined, 'active');
  }, [refreshConversations]);
  const refreshWorkspaceList = useCallback(async () => {
    const r = await clientApi.workspaceList();
    setWorkspaces(r.workspaces);
    setActiveWorkspace(r.activeWorkspace);
  }, []);



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
    setCollectionDrawer(null);
    setActivePage('chat');
  }, [activeWorkspace, conversationView, refreshConversations]);

  const handleNewChat = useCallback(async () => {
    const ws = registeredWorkspacePath(activeWorkspace, workspaces);
    setDraftWorkspacePath(ws);
    // 草稿态：不落库、不进左侧列表；首条消息发送时再 create。
    // 已在草稿态时再次点击：保留输入框内容，仅确保停留在草稿。
    setConversationView('active');
    setActiveConversationId(null);
    setCollectionDrawer(null);
    setActivePage('chat');
  }, [activeWorkspace, workspaces]);

  const handleCreateAutomation = useCallback(async () => {
    // Jump to the same new-task home as sidebar "新建任务", but prefill a GPT/Codex-style scheduled-task draft.
    const zh = (session?.locale ?? '').toLowerCase().startsWith('zh');
    const template = getAutomationCopy(zh).chatDraftTemplate;
    conversationStore.setDraft(null, template);
    setConversationView('active');
    setActiveConversationId(null);
    setCollectionDrawer(null);
    setActivePage('chat');
  }, [session?.locale]);

  useEffect(() => {
    const offNewChat = clientApi.onTrayNewChat?.(() => {
      void handleNewChat();
    });
    const offMore = clientApi.onTrayMore?.(() => {
      setCollectionDrawer(null);
      setActivePage('chat');
      setConversationView('active');
      void refreshConversations(activeWorkspace, 'active');
    });
    return () => {
      offNewChat?.();
      offMore?.();
    };
  }, [activeWorkspace, handleNewChat, refreshConversations]);

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

  const handleSelectConversation = useCallback((id: string) => {
    const target = conversations.find((conversation) => conversation.id === id);
    if (target?.workspacePath && target.workspacePath !== activeWorkspace) {
      setActiveWorkspace(target.workspacePath);
      void clientApi.workspaceSetActive({ path: target.workspacePath }).catch(() => {});
    }
    setActiveConversationId(id);
    setConversationDrawerOpen(false);
    setCollectionDrawer(null);
    setActivePage('chat');
  }, [activeWorkspace, conversations]);

  const handleContinueTask = useCallback((conversationId: string, options?: { readonly closeResult?: boolean }) => {
    // §14 继续讨论仅恢复会话现场：导航和聚焦都不是用户发言，不能改变任务状态。
    // 真正的新回合只由 ChatSurface.submitMessage → chatSend 创建。
    // 若用户随后新开 Goal，那是同会话下的新计划，原 Plan 应留下。
    if (options?.closeResult) {
      setResultDrawerItem(null);
      setResultDrawerAcceptTogether([]);
      setCollectionDrawer(null);
    }
    continueTaskInConversation(conversationId, {
      showActiveConversations: () => setConversationView('active'),
      selectConversation: setActiveConversationId,
      openConversationDrawer: () => setConversationDrawerOpen(true),
      focusComposer: () => {
        const focus = () => {
          document
            .querySelector<HTMLTextAreaElement>('.conversation-chat-drawer .chat-composer textarea')
            ?.focus();
        };
        window.requestAnimationFrame(focus);
        // Drawer + ChatSurface mount may lag one frame; retry once.
        window.setTimeout(focus, 80);
      },
    });
  }, []);

  const handleShowActiveConversations = useCallback(async () => {
    setConversationView('active');
    setActiveConversationId(null);
    setCollectionDrawer(null);
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
            className={`app-page-layer app-chat-page${activePage !== 'settings' ? ' is-active' : ''}`}
            aria-hidden={activePage === 'settings'}
            inert={activePage === 'settings'}
          >
            <WorkbenchProvider
              conversationId={activeConversationId}
              isPageActive={activePage === 'chat'}
            >
              <div className="app-layout">
            <Sidebar
              conversations={conversations}
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
              onOpenAutomations={() => {
                setCollectionDrawer(null);
                setActivePage('automations');
              }}
              onOpenTools={() => {
                setCollectionDrawer(null);
                setActivePage('tools');
              }}
              onOpenSettings={() => openSettings('general')}
              onOpenHome={() => {
                // 顶部「工作台」：跨工作区全部行动权
                setCollectionDrawer(null);
                setHomeScope('all');
                setActivePage('home');
              }}
              onOpenWorkspaceHome={(workspacePath: string) => {
                setActiveWorkspace(workspacePath);
              }}
              homeScope={homeScope}
              onWorkspaceChanged={handleWorkspaceChanged}
              startupSnapshot={startupSnapshot}
            />
            <section className="main-panel">
              {activePage === 'automations' ? (
                <section className="primary-page-shell" aria-label={isZh ? '自动化' : 'Automations'}>
                  <AutomationCenter
                    isZh={isZh}
                    defaultWorkspace={activeWorkspace ?? ''}
                    initialRunTarget={automationRunTarget}
                    onCreateNew={handleCreateAutomation}
                    onOpenConversation={(conversationId) => {
                      setConversationView('active');
                      setActiveConversationId(String(conversationId));
                      setCollectionDrawer(null);
                      setActivePage('chat');
                    }}
                  />
                </section>
              ) : activePage === 'home' ? (
                <section className="primary-page-shell task-overview-page-layer" aria-label={isZh ? '工作台' : 'Workbench'}>
                  <div className="task-overview-scroll-region">
                  {homeScope === 'all' ? (
                    <GlobalWorkbenchPage
                      enabled={!conversationDrawerOpen && collectionDrawer === null}
                      onOpenTasks={() => openCollectionDrawer('tasks')}
                      onOpenHistory={() => openCollectionDrawer('history')}
                      onNewTask={() => {
                        void handleNewChat();
                      }}
                      onOpenItem={(item: TaskOverviewItem, options?: OpenResultOptions) => {
                        if (item.actionRight === 'result_ready') {
                          openResultDrawer(item, options);
                          return;
                        }
                        const conversationId = item.conversationId;
                        if (conversationId) {
                          handleSelectConversation(String(conversationId));
                          focusTaskRelatedMessage(item);
                          return;
                        }
                        openCollectionDrawer('tasks');
                      }}
                      onAcceptResult={(item: TaskOverviewItem) => acceptResultFromWorkbench(item)}
                      acceptHandlerRef={workbenchAcceptRef}
                      onCancelItem={(item: TaskOverviewItem) => cancelPlanFromWorkbench(item)}
                      onOpenWorkspace={(workspacePath: string) => {
                        // 工作台脉搏仍进区级视图；侧栏点工作区只激活，不走这条路。
                        setCollectionDrawer(null);
                        setActiveWorkspace(workspacePath);
                        setHomeScope('workspace');
                        setActivePage('home');
                      }}
                    />
                  ) : (
                    <HomePage
                      enabled={!conversationDrawerOpen && collectionDrawer === null}
                      workspacePath={activeWorkspace ?? null}
                      onOpenTasks={() => openCollectionDrawer('tasks')}
                      onOpenHistory={() => openCollectionDrawer('history')}
                      onNewTask={() => {
                        void handleNewChat();
                      }}
                      onOpenItem={(item: TaskOverviewItem, options?: OpenResultOptions) => {
                        if (item.actionRight === 'result_ready') {
                          openResultDrawer(item, options);
                          return;
                        }
                        const conversationId = item.conversationId;
                        if (conversationId) {
                          handleSelectConversation(String(conversationId));
                          focusTaskRelatedMessage(item);
                          return;
                        }
                        openCollectionDrawer('tasks');
                      }}
                      onAcceptResult={(item: TaskOverviewItem) => acceptResultFromWorkbench(item)}
                      acceptHandlerRef={workbenchAcceptRef}
                      onCancelItem={(item: TaskOverviewItem) => cancelPlanFromWorkbench(item)}
                      onOpenTools={() => {
                        setConversationDrawerOpen(false);
                        setActivePage('tools');
                      }}
                    />
                  )}
                  </div>
                </section>
              ) : activePage === 'tools' ? (
                <section className="primary-page-shell" aria-label={isZh ? '插件' : 'Plugins'}>
                  <CapabilitiesPanel />
                </section>
              ) : (
                <section className="thread thread-has-header">
                  <ChatSurface
                  i18n={i18n}
                  providers={providers}
                  conversationId={activeConversationId}
                  conversationRevision={conversationRevision}
                  conversationTitle={conversations.find((c) => c.id === activeConversationId)?.title}
                  automationOrigin={conversations.find((c) => c.id === activeConversationId)?.automationOrigin ?? null}
                  systemInstructions={systemInstructions}
                  replyLanguage={replyLanguage}
                  gitBranchPrefix={gitBranchPrefix}
                  resumeTask={resumeTask}
                  onResumeConsumed={() => {
                    setResumeTask(null);
                    void clientApi.clearPendingTask().catch(() => {});
                  }}
                  onOpenSettings={() => openSettings('providers')}
                  onOpenTools={() => {
                    setCollectionDrawer(null);
                    setActivePage('tools');
                  }}
                  onProvidersRefresh={refreshProviders}
                  onConversationUpdated={() => { void refreshConversations(); }}
                  onStreamingChange={(convId, streaming) => {
                    if (!convId) return;
                    const prev = runningConversationIdsRef.current;
                    const has = prev.has(convId);
                    // Even if conversation membership is unchanged, still
                    // re-sync workspace dots when the local edge reports stop
                    // with zero remaining running conversations.
                    if (streaming === has && !( !streaming && prev.size === 0)) return;
                    const next = new Set(prev);
                    if (streaming) next.add(convId);
                    else next.delete(convId);
                    applyRunningConversationIds(next);
                    // Local streaming edges previously only updated conversation
                    // spinners. Workspace dots stayed lit until the next main
                    // active-stream broadcast — and could stick forever if that
                    // event was missed or path keys mismatched. Keep both in sync.
                    const nextWs = applyLocalStreamingWorkspaceChange({
                      prev: runningWorkspacePathsRef.current,
                      workspacePath: activeWorkspace,
                      isStreaming: streaming,
                      remainingRunningConversationCount: next.size,
                    });
                    if (!sameStringSet(runningWorkspacePathsRef.current, nextWs)) {
                      runningWorkspacePathsRef.current = nextWs;
                      setRunningWorkspacePaths(nextWs);
                    }
                  }}
                  onBranch={(id) => { setConversationView('active'); setActiveConversationId(id); void refreshConversations(activeWorkspace, 'active'); }}
                  onTaskStarted={(conversationId) => {
                    setConversationView('active');
                    setActiveConversationId(conversationId);
                    setCollectionDrawer(null);
                    setActivePage('chat');
                    void refreshConversations(draftWorkspacePath, 'active');
                  }}
                  onRenameConversation={handleRenameConversation}
                  onArchiveConversation={handleArchiveConversation}
                  onOpenAutomationRun={openAutomationRun}
                  workspacePath={activeConversationId ? activeWorkspace : draftWorkspacePath}
                  workspaces={workspaces}
                  onWorkspaceChange={async (workspacePath) => {
                    setDraftWorkspacePath(workspacePath);
                    if (!activeWorkspace && workspacePath) {
                      setActiveWorkspace(workspacePath);
                      const listed = await clientApi.workspaceList();
                      setWorkspaces(listed.workspaces.map((item) => ({
                        path: item.path,
                        name: item.name,
                        baseBranch: item.baseBranch,
                      })));
                    }
                  }}
                  onWorkspaceUpdated={refreshWorkspaceList}
                  isPageActive={activePage === 'chat' && !conversationDrawerOpen && collectionDrawer !== 'result'}
                  messageTarget={notificationMessageTarget}
                  />
                </section>
              )}
            </section>
                {activePage === 'chat' ? <WorkbenchPanel isZh={isZh} workspacePath={activeWorkspace} /> : null}
              </div>
            </WorkbenchProvider>
          </section>
          {activePage === 'settings' ? (
            <section className="app-page-layer app-settings-page is-active">
              <SettingsPage
                key={`settings-${settingsInitialSection}`}
                availableLocales={availableLocales}
                i18n={i18n}
                initialSection={settingsInitialSection}
                onBack={() => {
                  setCollectionDrawer(null);
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

      {collectionDrawer ? (
                <Drawer
                  onClose={() => {
                    const pending = resultAcceptancePending;
                    const acceptTogether = resultDrawerAcceptTogether;
                    closeResultDrawer();
                    if (pending) {
                      setResultAcceptancePending(null);
                      const targets = resolveResultDrawerAcceptanceTargets(pending, acceptTogether);
                      // 归组卡只占一张：动画打在当前打开的那张上，其余待签项直接落库。
                      void workbenchAcceptRef.current?.(pending);
                      for (const target of targets) {
                        if (target.taskId === pending.taskId) continue;
                        void acceptResultFromWorkbench(target);
                      }
                    }
                  }}
                  ariaLabel={
                    collectionDrawer === 'tasks'
                      ? isZh
                        ? '全部任务'
                        : 'All tasks'
                      : collectionDrawer === 'history'
                        ? isZh
                          ? '任务历史'
                          : 'Task history'
                        : isZh
                          ? '执行结果'
                          : 'Execution result'
                  }
                  panelClassName={
                    collectionDrawer === 'result'
                      ? `conversation-result-drawer${
                          conversationDrawerOpen
                            ? ' conversation-result-drawer--pushed'
                            : ''
                        }`
                      : 'workbench-collection-drawer'
                  }
                >
                  {({ requestClose }) =>
                    collectionDrawer === 'tasks' ? (
                      <div className="workbench-collection-drawer-shell">
                        <div className="workbench-collection-drawer-header">
                          <div>
                            <h2>{isZh ? '全部任务' : 'All tasks'}</h2>
                            <p>{isZh ? '当前 Workspace 的活跃任务清单' : 'Active tasks in current workspace'}</p>
                          </div>
                          <button type="button" className="workbench-collection-drawer-close" onClick={requestClose}>
                            {isZh ? '关闭' : 'Close'}
                          </button>
                        </div>
                        <div className="workbench-collection-drawer-body">
                          <TasksPage
                            workspacePath={activeWorkspace}
                            onOpenItem={(item) => {
                              if (!item.conversationId) return;
                              if (item.actionRight === 'result_ready') {
                                openResultDrawer(item);
                                return;
                              }
                              handleSelectConversation(String(item.conversationId));
                              focusTaskRelatedMessage(item);
                            }}
                          />
                        </div>
                      </div>
                    ) : collectionDrawer === 'history' ? (
                      <div className="workbench-collection-drawer-shell">
                        <div className="workbench-collection-drawer-header">
                          <div>
                            <h2>{isZh ? '任务历史' : 'Task history'}</h2>
                            <p>{isZh ? '已结束且无需再验收的记录' : 'Finished records that no longer need review'}</p>
                          </div>
                          <button type="button" className="workbench-collection-drawer-close" onClick={requestClose}>
                            {isZh ? '关闭' : 'Close'}
                          </button>
                        </div>
                        <div className="workbench-collection-drawer-body">
                          <HistoryPage workspacePath={activeWorkspace} />
                        </div>
                      </div>
                    ) : resultDrawerItem ? (
                      <>
                          <div className="conversation-result-drawer__body">
                            <div className="conversation-result-drawer__standalone">
                              <button
                                type="button"
                                className="conversation-result-drawer__icon-close"
                                onClick={requestClose}
                                disabled={Boolean(resultAcceptancePending)}
                                aria-label={isZh ? '关闭' : 'Close'}
                                title={isZh ? '关闭' : 'Close'}
                              >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                                  <path d="M18 6 6 18" />
                                  <path d="m6 6 12 12" />
                                </svg>
                              </button>
                              <ConversationResultView
                                item={resultDrawerItem}
                                isZh={isZh}
                                onCloseGateChange={setResultCloseGate}
                              />
                            </div>
                          </div>
                          {(() => {
                            const item = resultDrawerItem;
                            if (!item) return null;
                            const canAccept =
                              item.source === 'goal_plan' && Boolean(item.taskId);
                            if (!canAccept) return null;
                            const closeBlocked = Boolean(resultCloseGate && !resultCloseGate.ok);
                            return (
                              <footer className="conversation-result-drawer__footer">
                                {closeBlocked && resultCloseGate?.message ? (
                                  <p className="conversation-result-drawer__gate">{resultCloseGate.message}</p>
                                ) : null}
                                <button
                                  type="button"
                                  className="task-overview-btn"
                                  disabled={Boolean(resultAcceptancePending)}
                                  onClick={() => {
                                    void (async () => {
                                      if (item.source === 'goal_plan' && item.taskId) {
                                        try {
                                          await clientApi.goalPlansMarkRequestedUserInput({
                                            planId: item.taskId,
                                          });
                                        } catch {
                                          // 重开失败也不挡回会话：用户至少还能继续说。
                                        }
                                      }
                                      requestClose();
                                      if (item.conversationId) {
                                        handleSelectConversation(String(item.conversationId));
                                      }
                                    })();
                                  }}
                                >
                                  {isZh ? '继续追问' : 'Follow up'}
                                </button>
                                <button
                                  type="button"
                                  className="task-overview-btn task-overview-btn--primary"
                                  disabled={Boolean(resultAcceptancePending)}
                                  onClick={() => {
                                    if (resultAcceptancePending) return;
                                    void (async () => {
                                      let userOverride = false;
                                      if (closeBlocked) {
                                        const gapMessage = resultCloseGate?.message?.trim()
                                          || (isZh
                                            ? '还缺对照证据，不能直接归档。'
                                            : 'Evidence is still incomplete.');
                                        const ok = await confirm({
                                          title: isZh ? '证据不全，仍要归档？' : 'Archive with incomplete evidence?',
                                          message: isZh
                                            ? `${gapMessage}\n\n确认后会强制归档，并保留缺口记录。也可改点「继续追问」去补证据。`
                                            : `${gapMessage}\n\nThis will force-archive and keep the gap record. Or use Follow up to supply evidence.`,
                                          confirmText: isZh ? '仍要归档' : 'Archive anyway',
                                          cancelText: isZh ? '取消' : 'Cancel',
                                          tone: 'danger',
                                        });
                                        if (!ok) return;
                                        userOverride = true;
                                      }
                                      resultAcceptanceUserOverrideRef.current = userOverride;
                                      setResultAcceptancePending(item);
                                      requestClose();
                                    })();
                                  }}
                                >
                                  {resultAcceptancePending
                                    ? isZh
                                      ? '正在归档…'
                                      : 'Archiving…'
                                    : isZh
                                      ? '确认归档'
                                      : 'Archive'}
                                </button>
                              </footer>
                            );
                          })()}
                      </>
                    ) : (
                      <div className="conversation-result-drawer__body">
                        <p className="conversation-result-view__hint">
                          {isZh ? '未选择结果项。' : 'No result selected.'}
                        </p>
                      </div>
                    )
                  }
                </Drawer>
              ) : null}
          {conversationDrawerOpen && activeConversationId ? (
            <Drawer
              onClose={() => setConversationDrawerOpen(false)}
              ariaLabel={isZh ? '继续讨论' : 'Continue discussion'}
              panelClassName="conversation-result-drawer conversation-chat-drawer conversation-chat-drawer--nested"
              softBackdrop
            >
              <WorkbenchProvider
                conversationId={activeConversationId}
                isPageActive={conversationDrawerOpen}
                layoutHost="local"
              >
                <div className="conversation-chat-drawer-shell">
                  <div className="conversation-chat-drawer__body">
                    <ChatSurface
                      i18n={i18n}
                      providers={providers}
                      conversationId={activeConversationId}
                      conversationRevision={conversationRevision}
                      conversationTitle={conversations.find((c) => c.id === activeConversationId)?.title}
                      automationOrigin={conversations.find((c) => c.id === activeConversationId)?.automationOrigin ?? null}
                      systemInstructions={systemInstructions}
                      replyLanguage={replyLanguage}
                      gitBranchPrefix={gitBranchPrefix}
                      onOpenSettings={() => openSettings('providers')}
                      onProvidersRefresh={refreshProviders}
                      onConversationUpdated={() => { void refreshConversations(); }}
                      onBranch={(id) => {
                        setConversationView('active');
                        setActiveConversationId(id);
                        void refreshConversations(activeWorkspace, 'active');
                      }}
                      onRenameConversation={handleRenameConversation}
                      onArchiveConversation={handleArchiveConversation}
                      onOpenAutomationRun={openAutomationRun}
                      onClose={() => setConversationDrawerOpen(false)}
                      workspacePath={activeConversationId ? activeWorkspace : draftWorkspacePath}
                      workspaces={workspaces}
                      onWorkspaceChange={async (workspacePath) => {
                    setDraftWorkspacePath(workspacePath);
                    if (!activeWorkspace && workspacePath) {
                      setActiveWorkspace(workspacePath);
                      const listed = await clientApi.workspaceList();
                      setWorkspaces(listed.workspaces.map((item) => ({
                        path: item.path,
                        name: item.name,
                        baseBranch: item.baseBranch,
                      })));
                    }
                  }}
                      onWorkspaceUpdated={refreshWorkspaceList}
                      isPageActive={conversationDrawerOpen}
                      messageTarget={notificationMessageTarget}
                    />
                  </div>
                  <WorkbenchPanel isZh={isZh} workspacePath={activeWorkspace} />
                </div>
              </WorkbenchProvider>
            </Drawer>
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

      {/* 开屏完全磁盘访问检测：暂存档关闭。
          等 Apple 开发者账号就绪、正式签名/公证链路可用后再打开。
          相关实现仍保留：FullDiskAccessStartupGate / startup-os-permissions / full-disk-access-drag-float
          知识库：peer-knowledge/knowledge/experience/full-disk-access-startup-gate-archive.md */}
      {false && <FullDiskAccessStartupGate enabled={showMainShell} isZh={isZh} />}
    </main>
  );
}
