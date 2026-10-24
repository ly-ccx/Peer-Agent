import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import { clientApi } from '../clientApi';
import { PeerIcon } from '../ui/icons';
import { usePointerResize } from '../app/hooks/usePointerResize';
import { AutomationCenter } from '../automations/AutomationCenter';
import { CapabilitiesPanel } from '../app/components/CapabilitiesPanel';
import { VersionBadge } from '../app/components/VersionBadge';
import { AttentionSheet } from './AttentionSheet';
import { HistorySheet } from './HistorySheet';
import { BotAvatar } from './BotAvatar';
import { botAvatarMood, type BotAvatarMood } from './state/botAvatarState';
import { BotList } from './BotList';
import { AppMenu } from './AppMenu';
import { NewBotSheet } from './NewBotSheet';
import { useBotWorkSessions } from './state/useBotWorkSessions';
import { TaskCancellationProvider } from './state/TaskCancellation';
import { useBotModels } from './state/useBotModels';
import { BotConversation } from './conversation/BotConversation';
import { BotProfileDrawer } from './drawer/BotProfileDrawer';
import type { BotInspect } from './drawer/agentProcess';
import type { TaskConversationContext, TaskConversationRequest } from './state/taskConversationState';
import {
  BOT_LIST_WIDTH_DEFAULT,
  BOT_LIST_WIDTH_MAX,
  BOT_LIST_WIDTH_MIN,
  clampBotListWidth,
  enterBotSelection,
  moveBotSelection,
  sumNeedsYou,
  resolveBotMessageFocus,
  validateManagedBotName,
} from './state/botListState';
import {
  closeDrawer,
  locateDrawerSession,
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
  readonly i18n: I18nRuntime;
  readonly isZh: boolean;
  readonly activePage: BotPage;
  readonly workspacePath: string;
  readonly automationRunTarget: { automationId: string; runId: string } | null;
  readonly onOpenSettings: () => void;
  readonly onOpenProviders?: () => void;
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

export function BotListShell({
  i18n,
  isZh,
  activePage,
  workspacePath,
  automationRunTarget,
  onOpenSettings,
  onOpenProviders,
  hasModel = false,
  onOpenAutomations,
  onOpenCapabilities,
  onOpenConversation,
  onClosePage,
  notificationFocus = null,
}: BotListShellProps) {
  const list = useBotList();
  const resizeGesture = usePointerResize();
  const searchRef = useRef<HTMLInputElement | null>(null);
  const profileButtonRef = useRef<HTMLButtonElement | null>(null);
  const drawerTriggerRef = useRef<HTMLElement | null>(null);
  const [replyDetailsTarget, setReplyDetailsTarget] = useState<HTMLDivElement | null>(null);
  const [drawerLoadedFor, setDrawerLoadedFor] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [locateSessionId, setLocateSessionId] = useState<string | null>(null);
  const [inspect, setInspect] = useState<BotInspect | null>(null);
  const [taskContext, setTaskContext] = useState<TaskConversationContext | null>(null);
  const [taskRequest, setTaskRequest] = useState<(TaskConversationRequest & { readonly workspaceId: string }) | null>(null);
  const [replyFlash, setReplyFlash] = useState<string | null>(null);
  const [replyPresence, setReplyPresence] = useState<{ workspaceId: string; mood: BotAvatarMood | null } | null>(null);
  const updateReplyPresence = useCallback((workspaceId: string, mood: BotAvatarMood | null) => {
    setReplyPresence(current => current?.workspaceId === workspaceId && current.mood === mood ? current : { workspaceId, mood });
  }, []);
  const replyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [attention, setAttention] = useState<{ workspaceId?: string } | null>(null);
  const attentionRequestRef = useRef(0);
  const [attentionFocus, setAttentionFocus] = useState<{ workspaceId: string; messageId: string; requestId: number; notificationRequestId: number | null } | null>(null);
  const focusTarget = resolveBotMessageFocus(notificationFocus, attentionFocus);
  const [meHistoryOpen, setMeHistoryOpen] = useState(false);
  const [drawerMemory, setDrawerMemory] = useState<DrawerMemory>({ open: false, tab: 'overview', sessionId: null });
  const drawerEntered = useRef(false);
  const replayDrawerEntrance = drawerMemory.open && !drawerEntered.current;
  useEffect(() => { drawerEntered.current = drawerMemory.open; }, [drawerMemory.open]);
  const pageOverride = activePage === 'automations' || activePage === 'tools';
  const opened = list.catalog.find((item) => item.workspaceId === list.openedId) ?? null;
  const currentDrawerMemory = drawerLoadedFor === opened?.workspaceId ? drawerMemory : closeDrawer(drawerMemory);
  const avatarMoods = useMemo(() => new Map(list.catalog.map(item => {
    const mood = botAvatarMood(item.state, replyFlash === item.workspaceId);
    return [item.workspaceId, replyFlash !== item.workspaceId && mood !== 'needs_you' && (mood !== 'error' || replyPresence?.mood !== 'idle') && item.workspaceId === opened?.workspaceId
      && replyPresence?.workspaceId === item.workspaceId && replyPresence.mood ? replyPresence.mood : mood] as const;
  })), [list.catalog, replyFlash, opened?.workspaceId, replyPresence]);
  const openedAvatarMood = opened ? avatarMoods.get(opened.workspaceId) ?? botAvatarMood(opened.state) : 'idle';
  const work = useBotWorkSessions(opened?.workspaceId ?? null);
  const modelControls = useBotModels(opened?.workspaceId ?? null, opened?.profile ?? null, list.updateProfile);
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

  useEffect(() => {
    setLocateSessionId(null);
    setInspect(null);
    setTaskContext(null);
    setTaskRequest(null);
    setReplyFlash(null);
    setDrawerLoadedFor(null);
  }, [opened?.workspaceId]);

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
    const workspaceId = notificationFocus?.workspaceId
      || (notificationFocus?.drawerTab === 'memory' ? (openedIdRef.current || firstVisibleIdRef.current) : '');
    if (!workspaceId) return;
    setInspect(null);
    list.openBot(workspaceId);
    if (notificationFocus?.sessionId) {
      setLocateSessionId(notificationFocus.sessionId);
      setDrawerMemory((current) => locateDrawerSession(current, notificationFocus.sessionId || ''));
      return;
    }
    if (notificationFocus?.drawerTab) {
      setDrawerMemory((current) => openDrawer(current, notificationFocus.drawerTab || 'overview'));
    }
  }, [list.openBot, notificationFocus]);

  const lookingAtBot = Boolean(opened?.workspaceId) && !pageOverride && activePage !== 'settings';
  useEffect(() => {
    const workspaceId = lookingAtBot ? opened?.workspaceId : '';
    if (!workspaceId) {
      void clientApi.projectAgentMarkRead({ workspaceId: opened?.workspaceId || '_', viewing: false }).catch(() => {});
      return;
    }
    void clientApi.projectAgentMarkRead({ workspaceId }).catch(() => {});
  }, [lookingAtBot, opened?.workspaceId]);

  useEffect(() => {
    if (!locateSessionId) return;
    setInspect(null);
    setDrawerMemory((current) => locateDrawerSession(current, locateSessionId));
    setLocateSessionId(null);
  }, [locateSessionId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const palette = event.target instanceof Element && Boolean(event.target.closest('.conversation-search'));
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
      if (shortcut?.action === 'list-search') {
        event.preventDefault();
        event.stopPropagation();
        if (!list.sheetOpen) {
          searchRef.current?.focus();
          searchRef.current?.select();
        }
        return;
      }
      if (shortcut?.action === 'toggle-profile') {
        setInspect(null);
        if (!opened?.workspaceId) return;
        event.preventDefault();
        event.stopPropagation();
        setDrawerMemory((current) => (current.open ? closeDrawer(current) : openDrawer(current)));
        return;
      }
      if (shortcut?.action === 'switch-bot') {
        const next = list.visible[shortcut.index];
        if (!next) return;
        event.preventDefault();
        event.stopPropagation();
        list.openBot(next.workspaceId);
        return;
      }
      const meta = event.metaKey || event.ctrlKey;
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
        list.openBot(next);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [list, opened?.workspaceId, pageOverride]);

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
    // 拖拽全程保持高亮：:hover 在指针移出 6px 命中区（含快速外甩）时会丢掉，
    // 只有 data-active 能让整段拖拽稳定显示强调色。与 SidebarResizer 同写法。
    if (resizeGesture.start(event, {
      onMove: x => list.setWidth(clampBotListWidth(startWidth + x - startX)),
      onEnd: committed => { if (!committed) list.setWidth(startWidth); handle.removeAttribute('data-active'); },
    })) handle.setAttribute('data-active', 'true');
  };

  return (
    <TaskCancellationProvider workspaceId={opened?.workspaceId ?? null} onRefresh={work.reload}>
    <div className="bot-shell" data-bot-shell="open" style={{ ['--peer-bot-list-width' as string]: `${list.width}px` }}>
      <aside className="bot-column" aria-label={i18n.t('projectAgent.list.brand')}>
        <UpgradeBanner i18n={i18n} />
        <div className="bot-column-top">
          <div className="bot-brand">
            <span className="bot-brand-mark" aria-hidden="true">
              <img className="bot-brand-icon light" src="./logo-light.png" alt="" />
              <img className="bot-brand-icon dark" src="./logo-dark.png" alt="" />
            </span>
            <span>{i18n.t('projectAgent.list.brand')}</span>
          </div>
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
        <div className="bot-search-frame">
          <input
            ref={searchRef}
            aria-controls="bot-list"
            className="bot-search"
            type="search"
            value={list.query}
            placeholder={i18n.t('projectAgent.list.searchPlaceholder')}
            aria-label={i18n.t('projectAgent.list.searchPlaceholder')}
            onChange={(event) => list.setQuery(event.target.value)}
          />
          {needsYouCount > 0 || list.needsYouOnly ? (
            <button
              type="button"
              className={`bot-need-filter${list.needsYouOnly ? ' is-on' : ''}`}
              aria-expanded={attention !== null}
              aria-haspopup="dialog"
              onClick={() => setAttention({})}
            >
              {i18n.t('projectAgent.list.needsYou', { count: needsYouCount })}
            </button>
          ) : null}
        </div>
        <BotList
          items={list.visible}
          avatarMoods={avatarMoods}
          highlightedId={list.highlightedId}
          openedId={list.openedId}
          emptyLabel={list.catalog.length === 0 && list.status === 'ready' && !list.searching && !list.needsYouOnly
            ? i18n.t('projectAgent.list.empty')
            : emptyLabel}
          i18n={i18n}
          onHighlight={list.setHighlightedId}
          onOpen={list.openBot}
          onAttention={workspaceId => setAttention({ workspaceId })}
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
            metadata={<VersionBadge i18n={i18n} variant="bot-footer" />}
          />
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
              <BotAvatar avatar={opened.profile.avatar} label={opened.profile.displayName} workspaceId={opened.workspaceId}
                animate mood={openedAvatarMood} />
              <p className="bot-main-title">{opened.profile.displayName}</p>
              <button
                ref={profileButtonRef}
                type="button"
                className="bot-profile"
                data-profile-drawer="b2-16"
                data-seam="b2-16"
                data-session-id={locateSessionId ?? currentDrawerMemory.sessionId ?? undefined}
                aria-expanded={currentDrawerMemory.open && !inspect}
                onClick={() => {
                  drawerTriggerRef.current = profileButtonRef.current;
                  setInspect(null);
                  setDrawerMemory((current) => (
                    current.open && current.tab === 'settings' && !inspect
                      ? closeDrawer(current) : openDrawer(current, 'settings')
                  ));
                }}
              >
                <PeerIcon name="settings" size={16} strokeWidth={1.75} />
                <span>{i18n.t('projectAgent.list.profile')}</span>
              </button>
            </header>
            <BotConversation
              workIndex={work.index}
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
              onLocateSession={setLocateSessionId}
              contextSessionId={currentDrawerMemory.open && currentDrawerMemory.tab === 'tasks' ? currentDrawerMemory.sessionId : null}
              onTaskContext={setTaskContext}
              taskRequest={taskRequest?.workspaceId === opened.workspaceId ? taskRequest : null}
              replyDetailsId={inspect?.replyId ?? null}
              replyDetailsTarget={replyDetailsTarget}
              onInspect={(next) => {
                const trigger = document.activeElement;
                if (trigger instanceof HTMLButtonElement && !trigger.closest('.bot-drawer-body')) drawerTriggerRef.current = trigger;
                setInspect(next);
                setDrawerMemory((current) => openDrawer(current));
              }}
              focusMessageId={focusTarget?.workspaceId === opened.workspaceId ? focusTarget.messageId : null}
              focusRequestId={focusTarget?.workspaceId === opened.workspaceId ? focusTarget.requestId : 0}
            />
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
            <div className="bot-main-empty-content">
              <h1>{i18n.t('projectAgent.list.mainEmptyTitle')}</h1>
              <p>{i18n.t('projectAgent.list.mainEmptyBody')}</p>
              {list.catalog.length > 0 ? (
                <div className="bot-main-picks">
                  <span className="bot-main-picks-label">{i18n.t('projectAgent.list.recentBots')}</span>
                  {list.catalog.slice(0, 3).map((item) => (
                    <button
                      key={item.workspaceId}
                      type="button"
                      className="bot-main-pick"
                      onClick={() => list.openBot(item.workspaceId)}
                    >
                      <BotAvatar avatar={item.profile.avatar} label={item.profile.displayName} workspaceId={item.workspaceId}
                        mood={botAvatarMood(item.state)} />
                      <span className="bot-main-pick-copy">
                        <strong>{item.profile.displayName}</strong>
                        <small>{i18n.t('projectAgent.list.openBot')}</small>
                      </span>
                      <PeerIcon name="chevronRight" size={16} className="bot-main-pick-arrow" />
                    </button>
                  ))}
                </div>
              ) : null}
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
          memory={currentDrawerMemory}
          locateSessionId={locateSessionId}
          inspect={inspect}
          onReplyDetailsTarget={setReplyDetailsTarget}
          sessions={work.available ? work.sessions : []}
          sessionsAvailable={work.available}
          taskContext={taskContext?.workspaceId === opened.workspaceId ? taskContext : null}
          onTaskConversation={request => {
            setInspect(null);
            setDrawerMemory(current => closeDrawer(current));
            setTaskRequest(current => ({ ...request, workspaceId: opened.workspaceId, id: (current?.id ?? 0) + 1 }));
          }}
          onRefreshSessions={work.reload}
          onCloseInspect={() => setInspect(current => current?.evidence && current.replyId
            ? { replyId: current.replyId, evidence: null, rounds: null } : null)}
          triggerRef={drawerTriggerRef}
          i18n={i18n}
          isZh={isZh}
          onMemory={next => { if (next.open) setInspect(null); setDrawerMemory(next); }}
          onProfile={list.updateProfile}
          onOpenConversation={onOpenConversation}
          onOpenAutomations={onOpenAutomations}
          onDeleted={() => {
            setDrawerMemory((current) => closeDrawer(current));
          }}
        />
      ) : null}
      {attention ? <AttentionSheet workspaceId={attention.workspaceId} i18n={i18n}
        onClose={() => setAttention(null)} onChanged={() => { void list.reload(); }}
        onLocate={item => {
          list.openBot(item.workspaceId);
          if (item.messageId) setAttentionFocus({ workspaceId: item.workspaceId, messageId: item.messageId,
            requestId: --attentionRequestRef.current, notificationRequestId: notificationFocus?.requestId ?? null });
          else if (item.sessionId) {
            setAttentionFocus(null);
            setLocateSessionId(item.sessionId);
            setDrawerMemory(current => ({ ...openDrawer(current, 'tasks'), sessionId: item.sessionId ?? null }));
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
          list.openBot(workspaceId);
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
