import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import { clientApi } from '../clientApi';
import { PeerIcon } from '../ui/icons';
import { AutomationCenter } from '../automations/AutomationCenter';
import { CapabilitiesPanel } from '../app/components/CapabilitiesPanel';
import { HistorySheet } from './HistorySheet';
import { BotAvatar } from './BotAvatar';
import { botAvatarMood } from './state/botAvatarState';
import { BotList } from './BotList';
import { MeMenu } from './MeMenu';
import { NewBotSheet } from './NewBotSheet';
import { BotConversation } from './conversation/BotConversation';
import { BotProfileDrawer } from './drawer/BotProfileDrawer';
import type { BotInspect } from './drawer/agentProcess';
import {
  BOT_LIST_WIDTH_DEFAULT,
  BOT_LIST_WIDTH_MAX,
  BOT_LIST_WIDTH_MIN,
  clampBotListWidth,
  enterBotSelection,
  moveBotSelection,
  sumNeedsYou,
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
  readonly onCreateAutomation: () => void;
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
  onCreateAutomation,
  onClosePage,
  notificationFocus = null,
}: BotListShellProps) {
  const list = useBotList();
  const searchRef = useRef<HTMLInputElement | null>(null);
  const profileButtonRef = useRef<HTMLButtonElement | null>(null);
  const drawerLoadedFor = useRef<string | null>(null);
  const [name, setName] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [locateSessionId, setLocateSessionId] = useState<string | null>(null);
  const [inspect, setInspect] = useState<BotInspect | null>(null);
  const [replyFlash, setReplyFlash] = useState<string | null>(null);
  const replyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [meHistoryOpen, setMeHistoryOpen] = useState(false);
  const [drawerMemory, setDrawerMemory] = useState<DrawerMemory>({ open: false, tab: 'overview', sessionId: null });
  const pageOverride = activePage === 'automations' || activePage === 'tools';
  const opened = list.catalog.find((item) => item.workspaceId === list.openedId) ?? null;
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
    setReplyFlash(null);
    drawerLoadedFor.current = null;
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
    drawerLoadedFor.current = workspaceId;
  }, [opened?.workspaceId]);

  useEffect(() => {
    const workspaceId = opened?.workspaceId;
    if (!workspaceId || drawerLoadedFor.current !== workspaceId) return;
    writeDrawerMemory(workspaceId, drawerMemory, {
      get: (key) => localStorage.getItem(key),
      set: (key, value) => localStorage.setItem(key, value),
    });
  }, [drawerMemory, opened?.workspaceId]);

  useEffect(() => {
    const workspaceId = notificationFocus?.workspaceId
      || (notificationFocus?.drawerTab === 'memory' ? (openedIdRef.current || firstVisibleIdRef.current) : '');
    if (!workspaceId) return;
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
      if (list.menuOpen) {
        if (event.key === 'Escape') list.setMenuOpen(false);
        return;
      }
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
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = list.width;
    document.body.style.cursor = 'col-resize';
    const move = (ev: PointerEvent) => {
      list.setWidth(clampBotListWidth(startWidth + ev.clientX - startX));
    };
    const up = () => {
      document.body.style.cursor = '';
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
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
              aria-pressed={list.needsYouOnly}
              onClick={() => list.setNeedsYouOnly(!list.needsYouOnly)}
            >
              {i18n.t('projectAgent.list.needsYou', { count: needsYouCount })}
            </button>
          ) : null}
        </div>
        <BotList
          items={list.visible}
          highlightedId={list.highlightedId}
          openedId={list.openedId}
          emptyLabel={list.catalog.length === 0 && list.status === 'ready' && !list.searching && !list.needsYouOnly
            ? i18n.t('projectAgent.list.empty')
            : emptyLabel}
          i18n={i18n}
          onHighlight={list.setHighlightedId}
          onOpen={list.openBot}
        />
        {list.catalog.length === 0 && list.status === 'ready' && !list.searching ? (
          <p className="bot-list-hint">{i18n.t('projectAgent.list.emptyHint')}</p>
        ) : null}
        <MeMenu
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
                onCreateNew={onCreateAutomation}
              />
            ) : (
              <CapabilitiesPanel />
            )}
          </div>
        ) : opened ? (
          <div className="bot-main-thread motion-enter-fade" key={opened.workspaceId}>
            <header className="bot-main-head">
              <BotAvatar avatar={opened.profile.avatar} label={opened.profile.displayName} workspaceId={opened.workspaceId}
                mood={replyFlash === opened.workspaceId ? 'reply' : botAvatarMood(opened.state)} />
              <p className="bot-main-title">{opened.profile.displayName}</p>
              <button
                ref={profileButtonRef}
                type="button"
                className="bot-profile"
                data-profile-drawer="b2-16"
                data-seam="b2-16"
                data-session-id={locateSessionId ?? drawerMemory.sessionId ?? undefined}
                aria-expanded={drawerMemory.open}
                onClick={() => {
                  setDrawerMemory((current) => (
                    current.open ? closeDrawer(current) : openDrawer(current, 'overview')
                  ));
                }}
              >
                {i18n.t('projectAgent.list.profile')}
              </button>
            </header>
            <BotConversation
              workspaceId={opened.workspaceId}
              avatar={opened.profile.avatar}
              label={opened.profile.displayName}
              avatarMood={botAvatarMood(opened.state)}
              i18n={i18n}
              onReplyArrived={announceReply}
              onLocateSession={setLocateSessionId}
              onInspect={(next) => {
                setInspect(next);
                setDrawerMemory((current) => openDrawer(current));
              }}
              focusMessageId={notificationFocus?.workspaceId === opened.workspaceId ? notificationFocus.messageId : null}
              focusRequestId={notificationFocus?.workspaceId === opened.workspaceId ? notificationFocus.requestId : 0}
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
          workspaceId={opened.workspaceId}
          profile={opened.profile}
          memory={drawerMemory}
          locateSessionId={locateSessionId}
          inspect={inspect}
          triggerRef={profileButtonRef}
          i18n={i18n}
          isZh={isZh}
          onMemory={setDrawerMemory}
          onProfile={list.updateProfile}
          onOpenConversation={onOpenConversation}
          onOpenAutomations={onOpenAutomations}
          onDeleted={() => {
            setDrawerMemory((current) => closeDrawer(current));
          }}
        />
      ) : null}
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
            if (!result.ok && result.code !== 'CANCELLED') setErrorCode(result.code || 'FAILED');
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
            if (!result.ok && result.code !== 'CANCELLED') setErrorCode(result.code || 'FAILED');
            else setName('');
          });
        }}
        onClose={() => {
          if (list.creating) return;
          list.setSheetOpen(false);
          setErrorCode('');
        }}
      />
    </div>
  );
}
