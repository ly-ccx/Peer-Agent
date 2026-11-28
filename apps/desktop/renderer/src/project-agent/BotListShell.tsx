import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import type { InputDraftTaskRef } from '@peer-agent/protocol';
import { clientApi } from '../clientApi';
import { PeerIcon } from '../ui/icons';
import { useOptionalAppearance } from '../appearance/AppearanceProvider';
import { usePointerResize } from '../app/hooks/usePointerResize';
import { AutomationCenter, CapabilitiesPanel } from '../app/components/deferredPanels';
import { VersionBadge } from '../app/components/VersionBadge';
import { AttentionSheet } from './AttentionSheet';
import { HistorySheet } from './HistorySheet';
import { BotAvatar } from './BotAvatar';
import { ExecutorIcon } from './ExecutorIcon';
import { botAvatarMood, type BotAvatarMood } from './state/botAvatarState';
import { BotList } from './BotList';
import { AppMenu } from './AppMenu';
import { NewBotSheet } from './NewBotSheet';
import { useBotWorkSessions } from './state/useBotWorkSessions';
import { TaskCancellationProvider } from './state/TaskCancellation';
import { useBotModels } from './state/useBotModels';
import { useBotCapabilities } from './state/useBotCapabilities';
import { BotCapabilitiesButton } from './BotCapabilitiesPopover';
import { BotConversation } from './conversation/BotConversation';
import type { CiteTaskRequest } from './conversation/BotConversationComposer';
import { BotDocumentPreview } from './conversation/BotDocumentPreview';
import { BotResourceButton, useResourceWorkspace, useBotResourceOwner, type BotResourceOwner } from '../workbench/ResourceWorkspaceContext';
import { BotProfileDrawer } from './drawer/BotProfileDrawer';
import type { BotInspect } from './drawer/agentProcess';
import type { TaskConversationContext, TaskConversationRequest } from './state/taskConversationState';
import { TaskWorkspaceView } from './task-workspace/TaskWorkspaceView';
import {
  canGoBack,
  canGoForward,
  currentNavigationView,
  historyTotalOf,
  initialNavigationState,
  navigateBack,
  navigateForward,
  navigateTo,
  pruneDeletedWorkspace,
  sidebarActiveSessionsOf,
  toggleBotExpanded,
  toggleBotMoreTasks,
  toggleSidebarCollapsed,
  type NavigationState,
} from './state/botNavigationState';
import {
  BOT_LIST_WIDTH_DEFAULT,
  BOT_LIST_WIDTH_MAX,
  BOT_LIST_WIDTH_MIN,
  clampBotListWidth,
  enterBotSelection,
  formatBotListTime,
  moveBotSelection,
  sumNeedsYou,
  resolveBotMessageFocus,
  validateManagedBotName,
} from './state/botListState';
import {
  closeDrawer,
  openDrawer,
  readDrawerMemory,
  writeDrawerMemory,
  type DrawerMemory,
} from './state/drawerState';
import { BotOnboarding } from './onboarding/BotOnboarding';
import { UpgradeBanner } from './onboarding/UpgradeBanner';
import { botOnboardingStep } from './onboarding/botShell';
import { resolveBotShortcut } from './state/botShortcuts';
import { useBotList } from './state/useBotList';
import './styles/bot-list.css';

type BotPage = 'chat' | 'home' | 'automations' | 'tools' | 'settings';

export interface BotListShellProps {
  readonly onResourceOwnerChange?: (owner: BotResourceOwner | null) => void;
  readonly i18n: I18nRuntime;
  readonly isZh: boolean;
  readonly activePage: BotPage;
  readonly workspacePath: string;
  readonly automationRunTarget: { automationId: string; runId: string } | null;
  readonly onOpenSettings: () => void;
  readonly onOpenProviders?: () => void;
  readonly onOpenSearch?: () => void;
  readonly hasModel?: boolean;
  readonly onOpenAutomations: () => void;
  readonly onOpenCapabilities: () => void;
  readonly onOpenConversation: (conversationId: string | number) => void;
  readonly onClosePage: () => void;
  readonly notificationFocus?: {
    readonly workspaceId: string;
    readonly messageId: string | null;
    readonly sessionId?: string | null;
    readonly drawerTab?: 'overview' | 'tasks' | 'objectives' | 'memory' | 'settings' | null;
    readonly requestId: number;
  } | null;
}

function typingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || target.isContentEditable) return true;
  if (tag !== 'INPUT') return false;
  return target.getAttribute('type') !== 'search';
}

const ignoreResourceOwner = (_owner: BotResourceOwner | null) => {};

export function BotListShell({
  onResourceOwnerChange = ignoreResourceOwner,
  i18n,
  isZh,
  activePage,
  workspacePath,
  automationRunTarget,
  onOpenSettings,
  onOpenProviders,
  onOpenSearch,
  hasModel = false,
  onOpenAutomations,
  onOpenCapabilities,
  onOpenConversation,
  onClosePage,
  notificationFocus = null,
}: BotListShellProps) {
  const list = useBotList(activePage !== 'settings');
  const appearance = useOptionalAppearance();
  const resources = useResourceWorkspace();
  const showDetails = resources?.showDetails;
  const revealPrimary = resources?.revealPrimary;
  const resizeGesture = usePointerResize();
  const searchRef = useRef<HTMLInputElement | null>(null);
  const searchTriggerRef = useRef<HTMLButtonElement | null>(null);
  const focusSearchPending = useRef(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const showSearchInput = searchOpen || list.query.length > 0;
  const profileButtonRef = useRef<HTMLButtonElement | null>(null);
  const inspectorButtonRef = useRef<HTMLButtonElement | null>(null);
  const drawerTriggerRef = useRef<HTMLElement | null>(null);
  const [replyDetailsTarget, setReplyDetailsTarget] = useState<HTMLDivElement | null>(null);
  const [workPanelTarget, setWorkPanelTarget] = useState<HTMLSpanElement | null>(null);
  const [drawerLoadedFor, setDrawerLoadedFor] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [inspect, setInspect] = useState<BotInspect | null>(null);
  const [taskContext, setTaskContext] = useState<TaskConversationContext | null>(null);
  const [taskRequest, setTaskRequest] = useState<(TaskConversationRequest & { readonly workspaceId: string }) | null>(null);
  const [citeRequest, setCiteRequest] = useState<(CiteTaskRequest & { readonly workspaceId: string }) | null>(null);
  const [nav, setNav] = useState<NavigationState>(() => initialNavigationState(list.openedId));
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [openedWorkspacePath, setOpenedWorkspacePath] = useState('');
  const [replyFlash, setReplyFlash] = useState<string | null>(null);
  const [replyPresence, setReplyPresence] = useState<{ workspaceId: string; mood: BotAvatarMood | null } | null>(null);
  const updateReplyPresence = useCallback((workspaceId: string, mood: BotAvatarMood | null) => {
    setReplyPresence(current => current?.workspaceId === workspaceId && current.mood === mood ? current : { workspaceId, mood });
  }, []);
  const replyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [attention, setAttention] = useState<{ workspaceId?: string } | null>(null);
  const openBotAttention = useCallback((workspaceId: string) => { setAttention({ workspaceId }); }, []);
  const attentionRequestRef = useRef(0);
  const handledNotificationRef = useRef<number | null>(null);
  const [attentionFocus, setAttentionFocus] = useState<{ workspaceId: string; messageId: string; requestId: number; notificationRequestId: number | null } | null>(null);
  const focusTarget = resolveBotMessageFocus(notificationFocus, attentionFocus);
  const [meHistoryOpen, setMeHistoryOpen] = useState(false);
  const [drawerMemory, setDrawerMemory] = useState<DrawerMemory>({ open: false, tab: 'overview', sessionId: null });
  const drawerEntered = useRef(false);
  const replayDrawerEntrance = drawerMemory.open && !drawerEntered.current;
  useEffect(() => { drawerEntered.current = drawerMemory.open; }, [drawerMemory.open]);
  const pageOverride = activePage === 'automations' || activePage === 'tools';
  const opened = list.catalog.find((item) => item.workspaceId === list.openedId) ?? null;
  useBotResourceOwner(opened?.workspaceId ?? null, onResourceOwnerChange, opened?.profile.agentConversationId);
  const currentDrawerMemory = drawerLoadedFor === opened?.workspaceId ? drawerMemory : closeDrawer(drawerMemory);
  const detailsVisible = inspect && resources ? resources.detailsVisible : currentDrawerMemory.open;

  const activeNavView = currentNavigationView(nav);
  const activeTaskSessionId = activeNavView?.kind === 'task' && activeNavView.workspaceId === opened?.workspaceId
    ? activeNavView.sessionId
    : null;

  const openBotView = useCallback((workspaceId: string) => {
    setInspectorOpen(false);
    list.openBot(workspaceId);
    setNav((current) => navigateTo(current, { kind: 'bot', workspaceId }));
  }, [list]);

  const openTaskView = useCallback((workspaceId: string, sessionId: string) => {
    revealPrimary?.();
    setInspect(null);
    setInspectorOpen(false);
    setDrawerMemory((current) => closeDrawer(current));
    list.openBot(workspaceId);
    setNav((current) => navigateTo(current, { kind: 'task', workspaceId, sessionId }));
  }, [list, revealPrimary]);

  const goBack = useCallback(() => {
    setNav((current) => {
      if (!canGoBack(current)) return current;
      const next = navigateBack(current);
      const target = currentNavigationView(next);
      if (target) list.openBot(target.workspaceId);
      setInspectorOpen(false);
      return next;
    });
  }, [list]);

  const goForward = useCallback(() => {
    setNav((current) => {
      if (!canGoForward(current)) return current;
      const next = navigateForward(current);
      const target = currentNavigationView(next);
      if (target) list.openBot(target.workspaceId);
      setInspectorOpen(false);
      return next;
    });
  }, [list]);

  // Keep NavigationState synchronized when list.openedId changes externally (e.g. startup or creation)
  useEffect(() => {
    if (!list.openedId) return;
    setNav((current) => {
      const active = currentNavigationView(current);
      if (active?.workspaceId === list.openedId) return current;
      return navigateTo(current, { kind: 'bot', workspaceId: list.openedId! });
    });
  }, [list.openedId]);

  const avatarMoods = useMemo(() => new Map(list.catalog.map(item => {
    const mood = botAvatarMood(item.state, replyFlash === item.workspaceId);
    return [item.workspaceId, replyFlash !== item.workspaceId && mood !== 'needs_you' && (mood !== 'error' || replyPresence?.mood !== 'idle') && item.workspaceId === opened?.workspaceId
      && replyPresence?.workspaceId === item.workspaceId && replyPresence.mood ? replyPresence.mood : mood] as const;
  })), [list.catalog, replyFlash, opened?.workspaceId, replyPresence]);
  const openedAvatarMood = opened ? avatarMoods.get(opened.workspaceId) ?? botAvatarMood(opened.state) : 'idle';
  const work = useBotWorkSessions(opened?.workspaceId ?? null, activePage === 'chat');
  const modelControls = useBotModels(opened?.workspaceId ?? null, opened?.profile ?? null, list.updateProfile);
  const capabilities = useBotCapabilities(opened?.workspaceId ?? null, openedWorkspacePath, opened?.profile ?? null, list.updateProfile);
  const openedIdRef = useRef(list.openedId);
  const firstVisibleIdRef = useRef(list.visible[0]?.workspaceId ?? '');
  openedIdRef.current = list.openedId;
  firstVisibleIdRef.current = list.visible[0]?.workspaceId ?? '';
  const onboarding = botOnboardingStep({
    hasModel,
    botCount: list.catalog.length,
    ready: list.status === 'ready',
  });
  const needsYouCount = sumNeedsYou(list.catalog);

  const openedActive = useMemo(
    () => (opened ? sidebarActiveSessionsOf(opened, work.available ? work.sessions : null) : { items: [], total: 0 }),
    [opened, work.available, work.sessions],
  );
  const openedHistoryTotal = useMemo(
    () => historyTotalOf(opened, work.available ? work.sessions : null),
    [opened, work.available, work.sessions],
  );
  const activeTaskSession = useMemo(
    () => (activeTaskSessionId ? work.sessions.find((s) => s.sessionId === activeTaskSessionId) ?? null : null),
    [activeTaskSessionId, work.sessions],
  );
  const activeTaskTitle = useMemo(() => {
    if (!activeTaskSessionId) return '';
    if (activeTaskSession?.title && activeTaskSession.title !== activeTaskSessionId) return activeTaskSession.title;
    const fromSidebar = openedActive.items.find((t) => t.sessionId === activeTaskSessionId)?.title;
    if (fromSidebar && fromSidebar !== activeTaskSessionId) return fromSidebar;
    return i18n.t('projectAgent.chat.work.related');
  }, [activeTaskSessionId, activeTaskSession?.title, openedActive.items, i18n]);
  const toggleInspector = useCallback(() => {
    setInspectorOpen((current) => {
      const next = !current;
      if (next && resources?.open) resources.close();
      return next;
    });
  }, [resources]);

  useEffect(() => {
    if (resources?.open) setInspectorOpen(false);
  }, [resources?.open]);

  useEffect(() => {
    setInspect(null);
    setTaskContext(null);
    setTaskRequest(null);
    setReplyFlash(null);
    setDrawerLoadedFor(null);
    setInspectorOpen(false);
    setOpenedWorkspacePath('');
  }, [opened?.workspaceId]);

  useEffect(() => {
    if (!opened?.workspaceId) return;
    let cancelled = false;
    void clientApi.projectAgentGet({ workspaceId: opened.workspaceId }).then((got) => {
      if (!cancelled && got?.ok && typeof got.path === 'string') {
        setOpenedWorkspacePath(got.path);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [opened?.workspaceId]);

  const previousPageRef = useRef(activePage);
  useEffect(() => {
    if (previousPageRef.current === 'tools' && activePage !== 'tools') {
      void capabilities.refresh();
    }
    previousPageRef.current = activePage;
  }, [activePage, capabilities.refresh]);

  useEffect(() => () => {
    if (replyTimerRef.current) clearTimeout(replyTimerRef.current);
  }, []);

  const announceReply = useCallback((workspaceId: string) => {
    if (replyTimerRef.current) clearTimeout(replyTimerRef.current);
    setReplyFlash(workspaceId);
    replyTimerRef.current = setTimeout(() => setReplyFlash(null), 850);
  }, []);

  useEffect(() => {
    const workspaceId = opened?.workspaceId;
    if (!workspaceId) return;
    setDrawerMemory(readDrawerMemory(workspaceId, {
      get: (key) => localStorage.getItem(key),
      set: (key, value) => localStorage.setItem(key, value),
    }));
    setDrawerLoadedFor(workspaceId);
  }, [opened?.workspaceId]);

  useEffect(() => {
    const workspaceId = opened?.workspaceId;
    if (!workspaceId || drawerLoadedFor !== workspaceId) return;
    writeDrawerMemory(workspaceId, drawerMemory, {
      get: (key) => localStorage.getItem(key),
      set: (key, value) => localStorage.setItem(key, value),
    });
  }, [drawerMemory, drawerLoadedFor, opened?.workspaceId]);

  useEffect(() => {
    if (!notificationFocus || handledNotificationRef.current === notificationFocus.requestId) return;
    const workspaceId = notificationFocus.workspaceId
      || (notificationFocus.drawerTab === 'memory' ? (openedIdRef.current || firstVisibleIdRef.current) : '');
    if (!workspaceId) return;
    handledNotificationRef.current = notificationFocus.requestId;
    setInspect(null);
    if (notificationFocus.sessionId) {
      openTaskView(workspaceId, notificationFocus.sessionId);
      return;
    }
    openBotView(workspaceId);
    if (notificationFocus.drawerTab && notificationFocus.drawerTab !== 'tasks') {
      setDrawerMemory((current) => openDrawer(current, notificationFocus.drawerTab || 'overview'));
    }
  }, [openBotView, openTaskView, notificationFocus]);

  useEffect(() => window.peerAgent?.onResourceWindowReturn?.(request => {
    if (!request?.context || !Number.isFinite(request.expiresAt) || request.expiresAt <= Date.now()) return;
    const { context } = request;
    setInspect(null);
    openBotView(context.owner.workspaceId);
    onClosePage();
  }), [openBotView, onClosePage]);

  useEffect(() => window.peerAgent?.onBrowserWindowReturn?.(request => {
    if (!request?.workspaceId || !Number.isFinite(request.expiresAt) || request.expiresAt <= Date.now()) return;
    setInspect(null);
    openBotView(request.workspaceId);
    onClosePage();
  }), [openBotView, onClosePage]);

  const lookingAtBot = Boolean(opened?.workspaceId) && !pageOverride && activePage !== 'settings';
  useEffect(() => {
    const workspaceId = lookingAtBot ? opened?.workspaceId : '';
    if (!workspaceId) {
      void clientApi.projectAgentMarkRead({ workspaceId: opened?.workspaceId || '_', viewing: false }).catch(() => {});
      return;
    }
    void clientApi.projectAgentMarkRead({ workspaceId }).catch(() => {});
  }, [lookingAtBot, opened?.workspaceId]);

  const openListSearch = useCallback(() => {
    setSearchOpen(true);
    if (nav.sidebarCollapsed) setNav((current) => toggleSidebarCollapsed(current, false));
    if (searchRef.current && !nav.sidebarCollapsed) {
      searchRef.current.focus();
      searchRef.current.select();
    } else {
      focusSearchPending.current = true;
    }
  }, [nav.sidebarCollapsed]);

  useEffect(() => {
    if (!showSearchInput || nav.sidebarCollapsed || !focusSearchPending.current) return;
    focusSearchPending.current = false;
    searchRef.current?.focus();
    searchRef.current?.select();
  }, [showSearchInput, nav.sidebarCollapsed]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const palette = event.target instanceof Element && Boolean(event.target.closest('.conversation-search'));
      const meta = event.metaKey || event.ctrlKey;
      if (meta && !event.shiftKey && !event.altKey && !palette && !list.sheetOpen) {
        if (event.key === '[' && !typingTarget(event.target)) {
          event.preventDefault();
          goBack();
          return;
        }
        if (event.key === ']' && !typingTarget(event.target)) {
          event.preventDefault();
          goForward();
          return;
        }
        if (event.key === '\\' && !typingTarget(event.target)) {
          event.preventDefault();
          setNav((current) => toggleSidebarCollapsed(current));
          return;
        }
      }
      const shortcut = resolveBotShortcut({
        key: event.key,
        meta: event.metaKey,
        ctrl: event.ctrlKey,
        shift: event.shiftKey,
        alt: event.altKey,
        palette,
        shell: 'bots',
      });
      if (shortcut?.action === 'new-bot') {
        event.preventDefault();
        event.stopPropagation();
        setErrorCode('');
        list.setSheetOpen(true);
        list.setMenuOpen(false);
        return;
      }
      const localSearchFallback = !onOpenSearch && !palette && meta && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k';
      if ((shortcut?.action === 'list-search' && !palette) || localSearchFallback) {
        if (list.sheetOpen) return;
        event.preventDefault();
        event.stopPropagation();
        openListSearch();
        return;
      }
      if (event.key === 'Escape' && event.target === searchRef.current && !list.query) {
        event.preventDefault();
        event.stopPropagation();
        setSearchOpen(false);
        searchTriggerRef.current?.focus();
        return;
      }
      if (shortcut?.action === 'toggle-profile') {
        revealPrimary?.();
        setInspect(null);
        if (!opened?.workspaceId) return;
        event.preventDefault();
        event.stopPropagation();
        setDrawerMemory((current) => (current.open && detailsVisible ? closeDrawer(current) : openDrawer(current)));
        return;
      }
      if (shortcut?.action === 'switch-bot') {
        const next = list.visible[shortcut.index];
        if (!next) return;
        event.preventDefault();
        event.stopPropagation();
        openBotView(next.workspaceId);
        return;
      }
      if (list.sheetOpen) return;
      if (list.menuOpen) return;
      if (pageOverride) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (event.target !== searchRef.current) return;
        event.preventDefault();
        list.setHighlightedId(moveBotSelection(list.visible, list.highlightedId, event.key === 'ArrowDown' ? 1 : -1));
        return;
      }
      if (event.key === 'Enter' && !meta) {
        if (event.target !== searchRef.current) return;
        const next = enterBotSelection(list.visible, list.highlightedId);
        if (!next) return;
        event.preventDefault();
        openBotView(next);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [list, opened?.workspaceId, pageOverride, detailsVisible, revealPrimary, goBack, goForward, openBotView, onOpenSearch, openListSearch]);

  const emptyLabel = list.status === 'loading'
    ? i18n.t('projectAgent.list.loading')
    : list.status === 'disabled'
      ? i18n.t('projectAgent.list.unavailable')
      : list.status === 'error'
        ? i18n.t('projectAgent.list.loadFailed')
        : list.searching
          ? i18n.t('projectAgent.list.emptySearch')
          : list.needsYouOnly
            ? i18n.t('projectAgent.list.emptyNeedsYou')
            : i18n.t('projectAgent.list.empty');

  const onResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = list.width;
    if (resizeGesture.start(event, {
      onMove: x => list.setWidth(clampBotListWidth(startWidth + x - startX)),
      onEnd: committed => { if (!committed) list.setWidth(startWidth); handle.removeAttribute('data-active'); },
    })) handle.setAttribute('data-active', 'true');
  };

  const handleCiteToBot = useCallback((ref: InputDraftTaskRef, prefillText?: string) => {
    if (!opened) return;
    setCiteRequest((current) => ({
      workspaceId: opened.workspaceId,
      ref,
      prefillText,
      id: (current?.id ?? 0) + 1,
    }));
    openBotView(opened.workspaceId);
  }, [opened, openBotView]);

  const handleBackToBotFromTask = useCallback((focusMessageId?: string) => {
    if (!opened) return;
    openBotView(opened.workspaceId);
    if (focusMessageId) {
      setAttentionFocus({
        workspaceId: opened.workspaceId,
        messageId: focusMessageId,
        requestId: --attentionRequestRef.current,
        notificationRequestId: notificationFocus?.requestId ?? null,
      });
    }
  }, [opened, openBotView, notificationFocus?.requestId]);

  const openTaskConversation = useCallback((request: Omit<TaskConversationRequest, 'id'>) => {
    if (!opened) return;
    revealPrimary?.();
    setInspect(null);
    setDrawerMemory(current => closeDrawer(current));
    openBotView(opened.workspaceId);
    setTaskRequest(current => ({ ...request, workspaceId: opened.workspaceId, id: (current?.id ?? 0) + 1 }));
  }, [opened, openBotView, revealPrimary]);

  return (
    <TaskCancellationProvider workspaceId={opened?.workspaceId ?? null} onRefresh={work.reload}>
    <div
      className={`bot-shell${nav.sidebarCollapsed ? ' is-sidebar-collapsed' : ''}`}
      data-bot-shell="open"
      style={{ ['--peer-bot-list-width' as string]: `${list.width}px` }}
    >
      <aside
        className={`bot-column${nav.sidebarCollapsed ? ' is-collapsed' : ''}`}
        aria-label={i18n.t('projectAgent.list.brand')}
        aria-hidden={nav.sidebarCollapsed}
        inert={nav.sidebarCollapsed || undefined}
      >
        <UpgradeBanner i18n={i18n} />
        <div className="bot-sidebar-utilbar">
          <button
            type="button"
            className="bot-util-btn"
            aria-label={isZh ? '收起侧栏' : 'Collapse sidebar'}
            title={isZh ? '收起侧栏 (⌘\\)' : 'Collapse sidebar (⌘\\)'}
            onClick={() => setNav((current) => toggleSidebarCollapsed(current, true))}
          >
            <PeerIcon name="panelLeft" size={15} />
          </button>
          <div className="bot-util-nav">
            <button
              ref={searchTriggerRef}
              type="button"
              className="bot-util-btn"
              aria-label={onOpenSearch
                ? (isZh ? '全局搜索 (⌘K)' : 'Search (⌘K)')
                : i18n.t('projectAgent.list.searchPlaceholder')}
              aria-expanded={onOpenSearch ? undefined : showSearchInput}
              onClick={onOpenSearch ?? openListSearch}
            >
              <PeerIcon name="search" size={14} />
            </button>
            <button
              type="button"
              className="bot-util-btn"
              disabled={!canGoBack(nav)}
              aria-label={isZh ? '后退' : 'Back'}
              title={isZh ? '后退 (⌘[)' : 'Back (⌘[)'}
              onClick={goBack}
            >
              <PeerIcon name="chevronLeft" size={14} />
            </button>
            <button
              type="button"
              className="bot-util-btn"
              disabled={!canGoForward(nav)}
              aria-label={isZh ? '前进' : 'Forward'}
              title={isZh ? '前进 (⌘])' : 'Forward (⌘])'}
              onClick={goForward}
            >
              <PeerIcon name="chevronRight" size={14} />
            </button>
          </div>
        </div>
        <div className="bot-column-top">
          <div className="bot-brand">
            <span className="bot-brand-mark" aria-hidden="true">
              <img className="bot-brand-icon light" src="./logo-light.png" alt="" />
              <img className="bot-brand-icon dark" src="./logo-dark.png" alt="" />
            </span>
            <span className="bot-brand-copy">
              <span className="bot-brand-name">{i18n.t('projectAgent.list.brand')}</span>
              <VersionBadge i18n={i18n} variant="bot-subtitle" />
            </span>
          </div>
          <VersionBadge i18n={i18n} variant="bot-upgrade" />
          <button
            type="button"
            className="bot-new"
            aria-label={i18n.t('projectAgent.list.newBot')}
            onClick={() => {
              setErrorCode('');
              list.setMenuOpen(false);
              list.setSheetOpen(true);
            }}
          >
            <svg className="bot-new-icon" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 3.25v9.5M3.25 8h9.5" />
            </svg>
          </button>
        </div>
        {showSearchInput ? <div className="bot-search-frame">
          <PeerIcon name="search" size={13} className="bot-search-icon" />
          <input
            ref={searchRef}
            aria-controls="bot-list"
            className="bot-search"
            type="search"
            value={list.query}
            placeholder={i18n.t('projectAgent.list.searchPlaceholder')}
            aria-label={i18n.t('projectAgent.list.searchPlaceholder')}
            onChange={(event) => list.setQuery(event.target.value)}
            onBlur={() => setSearchOpen(false)}
          />
        </div> : null}
        <BotList
          items={list.visible}
          avatarMoods={avatarMoods}
          highlightedId={list.highlightedId}
          openedId={list.openedId}
          activeSessionId={activeTaskSessionId}
          openedLiveSessions={work.available ? work.sessions : null}
          expandedBots={nav.expandedBots}
          expandedMoreBots={nav.expandedMoreBots}
          emptyLabel={list.catalog.length === 0 && list.status === 'ready' && !list.searching && !list.needsYouOnly
            ? i18n.t('projectAgent.list.empty')
            : emptyLabel}
          i18n={i18n}
          onHighlight={list.setHighlightedId}
          onOpen={openBotView}
          onAttention={openBotAttention}
          onToggleExpand={(workspaceId) => setNav((current) => toggleBotExpanded(current, workspaceId))}
          onToggleMoreTasks={(workspaceId) => setNav((current) => toggleBotMoreTasks(current, workspaceId))}
          onOpenTask={openTaskView}
        />
        {list.catalog.length === 0 && list.status === 'ready' && !list.searching ? (
          <p className="bot-list-hint">{i18n.t('projectAgent.list.emptyHint')}</p>
        ) : null}
        <footer className="bot-column-footer">
          <AppMenu
            open={list.menuOpen}
            i18n={i18n}
            onToggle={() => list.setMenuOpen(!list.menuOpen)}
            onClose={() => list.setMenuOpen(false)}
            onOpenSettings={() => {
              list.setMenuOpen(false);
              onOpenSettings();
            }}
            onOpenHistory={() => {
              list.setMenuOpen(false);
              setMeHistoryOpen(true);
            }}
            onOpenAutomations={() => {
              list.setMenuOpen(false);
              onOpenAutomations();
            }}
            onOpenCapabilities={() => {
              list.setMenuOpen(false);
              onOpenCapabilities();
            }}
          />
          <div className="bot-dock-actions">
            {needsYouCount > 0 || list.needsYouOnly ? (
              <button
                type="button"
                className={`bot-dock-needs${list.needsYouOnly ? ' is-on' : ''}`}
                aria-expanded={attention !== null}
                aria-haspopup="dialog"
                onClick={() => setAttention({})}
              >
                <PeerIcon name="warning" size={13} />
                <span>{i18n.t('projectAgent.list.needsYou', { count: needsYouCount })}</span>
              </button>
            ) : null}
            {appearance ? (
              <button
                type="button"
                className="bot-dock-theme"
                aria-label={appearance.activeScheme === 'dark' ? (isZh ? '切换到浅色外观' : 'Switch to light theme') : (isZh ? '切换到深色外观' : 'Switch to dark theme')}
                title={appearance.activeScheme === 'dark' ? (isZh ? '切换浅色' : 'Light mode') : (isZh ? '切换深色' : 'Dark mode')}
                onClick={() => appearance.setMode(appearance.activeScheme === 'dark' ? 'light' : 'dark')}
              >
                <PeerIcon name={appearance.activeScheme === 'dark' ? 'sun' : 'moon'} size={14} />
              </button>
            ) : null}
          </div>
        </footer>
        <div
          className="bot-column-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label={i18n.t('projectAgent.list.columnResize')}
          aria-valuemin={BOT_LIST_WIDTH_MIN}
          aria-valuemax={BOT_LIST_WIDTH_MAX}
          aria-valuenow={list.width}
          tabIndex={0}
          onPointerDown={onResizeStart}
          onDoubleClick={() => list.setWidth(BOT_LIST_WIDTH_DEFAULT)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') list.setWidth(clampBotListWidth(list.width - 8));
            if (event.key === 'ArrowRight') list.setWidth(clampBotListWidth(list.width + 8));
            if (event.key === 'Home') list.setWidth(BOT_LIST_WIDTH_MIN);
            if (event.key === 'End') list.setWidth(BOT_LIST_WIDTH_MAX);
          }}
        />
      </aside>
      <section className="bot-main" aria-label={opened?.profile.displayName ?? i18n.t('projectAgent.list.mainEmptyTitle')}>
        {pageOverride ? (
          <div className="bot-main-page">
            <button type="button" className="bot-back" onClick={onClosePage}>
              {i18n.t('projectAgent.list.backToBots')}
            </button>
            {activePage === 'automations' ? (
              <AutomationCenter
                isZh={isZh}
                defaultWorkspace={workspacePath}
                initialRunTarget={automationRunTarget}
                onOpenConversation={onOpenConversation}
              />
            ) : (
              <CapabilitiesPanel />
            )}
          </div>
        ) : opened ? (
          <div className="bot-main-thread motion-enter-fade" key={opened.workspaceId}>
            <header className="bot-main-head">
              {nav.sidebarCollapsed ? (
                <button
                  type="button"
                  className="bot-profile is-icon bot-sidebar-expand"
                  aria-label={isZh ? '展开侧栏' : 'Expand sidebar'}
                  title={isZh ? '展开侧栏 (⌘\\)' : 'Expand sidebar (⌘\\)'}
                  onClick={() => setNav((current) => toggleSidebarCollapsed(current, false))}
                >
                  <PeerIcon name="panelLeft" size={16} />
                </button>
              ) : null}
              {activeTaskSessionId ? (
                <>
                  <nav className="bot-main-crumbs" aria-label={isZh ? '当前位置' : 'Breadcrumb'}>
                    <button
                      type="button"
                      className="bot-crumb-parent"
                      onClick={() => openBotView(opened.workspaceId)}
                    >
                      <BotAvatar
                        avatar={opened.profile.avatar}
                        label={opened.profile.displayName}
                        workspaceId={opened.workspaceId}
                        mood={openedAvatarMood}
                      />
                      <span>{opened.profile.displayName}</span>
                    </button>
                    <PeerIcon name="chevronRight" size={14} className="bot-crumb-sep" />
                    <ExecutorIcon className="bot-crumb-cli" />
                    <span className="bot-crumb-current">{activeTaskTitle}</span>
                  </nav>
                  <BotCapabilitiesButton
                    mode="inherited"
                    botName={opened.profile.displayName}
                    capabilities={capabilities}
                    i18n={i18n}
                    onAdjustOnBot={() => {
                      openBotView(opened.workspaceId);
                      setInspect(null);
                      setDrawerMemory((current) => openDrawer(current, 'capabilities'));
                    }}
                  />
                  <button
                    ref={inspectorButtonRef}
                    type="button"
                    className={`bot-profile bot-inspector-toggle${inspectorOpen ? ' is-active' : ''}`}
                    aria-expanded={inspectorOpen}
                    onClick={toggleInspector}
                  >
                    <PeerIcon name="panelRight" size={15} />
                    <span>{isZh ? '任务详情' : 'Details'}</span>
                  </button>
                  <BotResourceButton isZh={isZh} />
                </>
              ) : (
                <>
                  <BotAvatar avatar={opened.profile.avatar} label={opened.profile.displayName} workspaceId={opened.workspaceId}
                    animate mood={openedAvatarMood} />
                  <p className="bot-main-title">{opened.profile.displayName}</p>
                  <BotCapabilitiesButton
                    mode="bot"
                    botName={opened.profile.displayName}
                    capabilities={capabilities}
                    i18n={i18n}
                    onOpenDrawerCapabilities={() => {
                      setInspect(null);
                      setDrawerMemory((current) => openDrawer(current, 'capabilities'));
                    }}
                    onOpenGlobalPlugins={onOpenCapabilities}
                  />
                  <button
                    ref={profileButtonRef}
                    type="button"
                    className="bot-profile is-icon"
                    title={i18n.t('projectAgent.list.profile')}
                    aria-label={i18n.t('projectAgent.list.profile')}
                    data-profile-drawer="b2-16"
                    data-seam="b2-16"
                    data-session-id={currentDrawerMemory.sessionId ?? undefined}
                    aria-expanded={currentDrawerMemory.open && !inspect}
                    onClick={() => {
                      drawerTriggerRef.current = profileButtonRef.current;
                      setInspect(null);
                      setDrawerMemory((current) => (
                        current.open && !inspect && detailsVisible
                          ? closeDrawer(current) : openDrawer(current, 'settings')
                      ));
                    }}
                  >
                    <PeerIcon name="settings" size={16} strokeWidth={1.75} />
                  </button>
                  <BotResourceButton isZh={isZh} />
                  <span className="bot-work-panel-header-slot" ref={setWorkPanelTarget} />
                </>
              )}
            </header>
            <BotDocumentPreview key={opened.workspaceId} workspaceId={opened.workspaceId} i18n={i18n}>
              <div className="bot-main-stage-convo" hidden={Boolean(activeTaskSessionId)}>
                <BotConversation
                  workIndex={work.index}
                  onRefreshWork={work.reload}
                  workPanelTarget={workPanelTarget}
                  key={opened.workspaceId}
                  workspaceId={opened.workspaceId}
                  profile={opened.profile}
                  modelControls={modelControls}
                  avatar={opened.profile.avatar}
                  label={opened.profile.displayName}
                  avatarMood={openedAvatarMood}
                  i18n={i18n}
                  onReplyArrived={announceReply}
                  onReplyPresenceChange={updateReplyPresence}
                  onLocateSession={(sessionId) => openTaskView(opened.workspaceId, sessionId)}
                  onTaskConversation={openTaskConversation}
                  onOpenHistory={() => setMeHistoryOpen(true)}
                  onOpenManagement={(objectiveId) => {
                    showDetails?.();
                    const trigger = document.activeElement;
                    if (trigger instanceof HTMLButtonElement) drawerTriggerRef.current = trigger;
                    setInspect(null);
                    setDrawerMemory(current => ({ ...openDrawer(current, objectiveId ? 'objectives' : 'settings'), objectiveId }));
                  }}
                  contextSessionId={activeTaskSessionId}
                  onTaskContext={setTaskContext}
                  taskRequest={taskRequest?.workspaceId === opened.workspaceId ? taskRequest : null}
                  citeRequest={citeRequest?.workspaceId === opened.workspaceId ? citeRequest : null}
                  activeTasks={openedActive.items}
                  historyTotal={openedHistoryTotal}
                  replyDetailsId={inspect?.replyId ?? null}
                  replyDetailsTarget={replyDetailsTarget}
                  onInspect={(next) => {
                    showDetails?.();
                    const trigger = document.activeElement;
                    if (trigger instanceof HTMLButtonElement && !trigger.closest('.bot-drawer-body')) drawerTriggerRef.current = trigger;
                    setInspect(next);
                    setDrawerMemory((current) => openDrawer(current));
                  }}
                  focusMessageId={focusTarget?.workspaceId === opened.workspaceId ? focusTarget.messageId : null}
                  focusRequestId={focusTarget?.workspaceId === opened.workspaceId ? focusTarget.requestId : 0}
                />
              </div>
              {activeTaskSessionId ? (
                <TaskWorkspaceView
                  key={`${opened.workspaceId}:${activeTaskSessionId}`}
                  workspaceId={opened.workspaceId}
                  workspacePath={openedWorkspacePath}
                  profile={opened.profile}
                  sessionId={activeTaskSessionId}
                  liveSession={activeTaskSession}
                  sessionsAvailable={work.available}
                  context={taskContext?.sessionId === activeTaskSessionId ? taskContext : null}
                  inspectorOpen={inspectorOpen}
                  inspectorTriggerRef={inspectorButtonRef}
                  i18n={i18n}
                  isZh={isZh}
                  onToggleInspector={toggleInspector}
                  onCloseInspector={() => setInspectorOpen(false)}
                  onBackToBot={handleBackToBotFromTask}
                  onTaskConversation={openTaskConversation}
                  onOpenTask={(nextSessionId) => openTaskView(opened.workspaceId, nextSessionId)}
                  onCiteToBot={handleCiteToBot}
                  onRefreshSessions={work.reload}
                />
              ) : null}
            </BotDocumentPreview>
          </div>
        ) : onboarding ? (
          <BotOnboarding
            step={onboarding}
            i18n={i18n}
            onConnect={() => onOpenProviders?.()}
            onCreate={() => {
              setErrorCode('');
              list.setMenuOpen(false);
              list.setSheetOpen(true);
            }}
          />
        ) : (
          <div className="bot-main-empty">
            <div className="bot-main-empty-drag" aria-hidden="true" />
            <div className="bot-main-empty-content">
              <div className="bot-home-hero">
                <span className="bot-home-emblem" aria-hidden="true">
                  <img className="bot-brand-icon light" src="./logo-light.png" alt="" />
                  <img className="bot-brand-icon dark" src="./logo-dark.png" alt="" />
                </span>
                <h1>{i18n.t('projectAgent.list.mainEmptyTitle')}</h1>
                <p>{i18n.t('projectAgent.list.mainEmptyBody')}</p>
              </div>
              {list.catalog.length > 0 ? (
                <div className="bot-main-picks">
                  <div className="bot-main-picks-head">
                    <span className="bot-main-picks-label">{i18n.t('projectAgent.list.recentBots')}</span>
                    <button
                      type="button"
                      className="bot-main-picks-create"
                      onClick={() => {
                        setErrorCode('');
                        list.setMenuOpen(false);
                        list.setSheetOpen(true);
                      }}
                    >
                      <PeerIcon name="plus" size={13} />
                      <span>{isZh ? '新建项目' : 'New project'}</span>
                    </button>
                  </div>
                  <div className={`bot-main-picks-grid${list.catalog.length === 1 ? ' is-single' : ''}`}>
                    {list.catalog.slice(0, 4).map((item) => {
                      const timeLabel = formatBotListTime(item.lastActiveAt);
                      const cardMood = botAvatarMood(item.state);
                      const previewText = item.preview.trim()
                        || (isZh ? '随时开始新的对话或交代任务' : 'Start a conversation or assign a task');
                      return (
                        <button
                          key={item.workspaceId}
                          type="button"
                          className="bot-main-pick"
                          onClick={() => openBotView(item.workspaceId)}
                        >
                          <div className="bot-main-pick-top">
                            <BotAvatar
                              avatar={item.profile.avatar}
                              label={item.profile.displayName}
                              workspaceId={item.workspaceId}
                              animate={cardMood !== 'idle'}
                              mood={cardMood}
                            />
                            <span className="bot-main-pick-meta">
                              {item.state.needsYou > 0 ? (
                                <span className="bot-main-pick-pill is-warn">
                                  {isZh ? `待处理 ${item.state.needsYou}` : `${item.state.needsYou} pending`}
                                </span>
                              ) : item.state.running > 0 ? (
                                <span className="bot-main-pick-pill is-active">
                                  {isZh ? '进行中' : 'Active'}
                                </span>
                              ) : timeLabel ? (
                                <span className="bot-main-pick-time">{timeLabel}</span>
                              ) : null}
                            </span>
                          </div>
                          <span className="bot-main-pick-copy">
                            <strong>{item.profile.displayName}</strong>
                            <small>{previewText}</small>
                          </span>
                          <span className="bot-main-pick-foot">
                            <span>{i18n.t('projectAgent.list.openBot')}</span>
                            <PeerIcon name="arrowRight" size={13} className="bot-main-pick-arrow" />
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
              <div className="bot-home-shortcuts" aria-hidden="true">
                <span><kbd>⌘K</kbd>{isZh ? '搜索项目与消息' : 'Search projects'}</span>
                <span className="bot-home-shortcuts-dot">·</span>
                <span><kbd>⌘,</kbd>{isZh ? '设置' : 'Settings'}</span>
              </div>
            </div>
          </div>
        )}
      </section>
      {opened && !pageOverride ? (
        <BotProfileDrawer
          key={opened.workspaceId}
          workspaceId={opened.workspaceId}
          profile={opened.profile}
          replayEntrance={replayDrawerEntrance}
          modelControls={modelControls}
          capabilities={capabilities}
          memory={currentDrawerMemory}
          locateSessionId={null}
          inspect={inspect}
          onReplyDetailsTarget={setReplyDetailsTarget}
          sessions={work.available ? work.sessions : []}
          sessionsAvailable={work.available}
          taskContext={taskContext?.workspaceId === opened.workspaceId ? taskContext : null}
          onTaskConversation={openTaskConversation}
          onOpenTask={(sessionId) => openTaskView(opened.workspaceId, sessionId)}
          onRefreshSessions={work.reload}
          onCloseInspect={() => {
            if (!inspect?.evidence || !inspect.replyId) revealPrimary?.();
            setInspect(current => current?.evidence && current.replyId
              ? { replyId: current.replyId, evidence: null, rounds: null } : null);
          }}
          triggerRef={drawerTriggerRef}
          i18n={i18n}
          isZh={isZh}
          onMemory={next => { if (next.open) { revealPrimary?.(); setInspect(null); } else if (inspect) resources?.close(); setDrawerMemory(next); }}
          onProfile={list.updateProfile}
          onOpenConversation={onOpenConversation}
          onOpenAutomations={onOpenAutomations}
          onOpenCapabilities={onOpenCapabilities}
          onDeleted={() => {
            setDrawerMemory((current) => closeDrawer(current));
            setNav((current) => pruneDeletedWorkspace(current, opened.workspaceId));
          }}
        />
      ) : null}
      {attention ? <AttentionSheet workspaceId={attention.workspaceId} i18n={i18n}
        onClose={() => setAttention(null)} onChanged={() => { void list.reload(); }}
        onLocate={item => {
          if (item.messageId) {
            openBotView(item.workspaceId);
            setAttentionFocus({ workspaceId: item.workspaceId, messageId: item.messageId,
              requestId: --attentionRequestRef.current, notificationRequestId: notificationFocus?.requestId ?? null });
          } else if (item.sessionId) {
            setAttentionFocus(null);
            openTaskView(item.workspaceId, item.sessionId);
          } else {
            openBotView(item.workspaceId);
          }
        }} /> : null}
      <HistorySheet
        open={meHistoryOpen}
        unscoped
        bots={list.catalog.map((item) => ({
          workspaceId: item.workspaceId,
          displayName: item.profile.displayName,
        }))}
        i18n={i18n}
        onClose={() => setMeHistoryOpen(false)}
        onContinued={(workspaceId) => {
          setMeHistoryOpen(false);
          openBotView(workspaceId);
        }}
      />
      <NewBotSheet
        open={list.sheetOpen}
        busy={list.creating}
        name={name}
        errorCode={errorCode}
        i18n={i18n}
        onName={(value) => {
          setName(value);
          if (errorCode === 'INVALID_NAME') setErrorCode('');
        }}
        onBind={() => {
          setErrorCode('');
          void list.createBind().then((result) => {
            if (!result.ok && result.code !== 'CANCELLED' && result.code !== 'BUSY') setErrorCode(result.code || 'FAILED');
          });
        }}
        onCreate={() => {
          const checked = validateManagedBotName(name);
          if (!checked.ok) {
            setErrorCode(checked.code);
            return;
          }
          setErrorCode('');
          void list.createManaged(checked.name).then((result) => {
            if (!result.ok && result.code !== 'CANCELLED' && result.code !== 'BUSY') setErrorCode(result.code || 'FAILED');
            else if (result.ok) setName('');
          });
        }}
        onClose={() => {
          if (list.creating) return;
          list.setSheetOpen(false);
          setErrorCode('');
        }}
      />
    </div>
    </TaskCancellationProvider>
  );
}
