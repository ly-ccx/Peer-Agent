import { browserFeedbackNoticeText } from '../feedback/browserFeedbackNotice';
import { createCompositionGuard } from '../../chat/state/compositionGuard';
import { MotionSurface } from '../../app/components/MotionSurface';
import { PeerIcon } from '../../ui/icons';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { clientApi } from '../../clientApi';
import { ResourceTabStrip } from '../ResourceTabStrip';
import { BrowserPage, initialRuntime, safeGetWebContentsId, type WebviewElement, type BrowserTabRuntimeState } from './BrowserPage';
import { browserRecoveryDescription } from '../browserRecoveryState';
import { MotionDetails } from '../../app/components/MotionDetails';
import {
  BROWSER_HOME_URL,
  activateBrowserTab,
  addBrowserTab,
  closeBrowserTab,
  createBrowserTabSession,
  updateBrowserTab,
  type BrowserSessionState,
  type BrowserTabSession,
} from '../browserSessionState';
import {
  buildBrowserOverflowMenu,
  type BrowserMenuActionId,
} from '../browserMenuModel';
import { SessionImportWizard } from './SessionImportWizard';
import { PasswordManagerPanel } from './PasswordManagerPanel';

interface BrowserViewProps {
  readonly hideTabStrip?: boolean;
  readonly suspendBlank?: boolean;
  readonly lazyTabs?: boolean;
  readonly isZh: boolean;
  readonly conversationId: string | null;
  readonly session: BrowserSessionState;
  readonly onSessionChange: (
    next: BrowserSessionState | ((current: BrowserSessionState) => BrowserSessionState),
  ) => void;
  /** 只有前台可见会话才能改窗口菜单绑定的 Browser 目标。 */
  readonly claimForeground?: boolean;
}

function normalizeInput(raw: string): string {
  const text = raw.trim();
  if (!text) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  if (/^(about|data|file|chrome):/i.test(text)) return text;
  const looksLikeDomain =
    /^localhost(:\d+)?(\/.*)?$/i.test(text) ||
    /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(text) ||
    /^[^\s/]+\.[^\s/]{2,}([/?#].*)?$/.test(text);
  if (looksLikeDomain) return `https://${text}`;
  return `https://www.bing.com/search?q=${encodeURIComponent(text)}`;
}

function displayUrl(url: string): string {
  if (!url || url === BROWSER_HOME_URL) return '';
  return url;
}

function tabLabel(tab: BrowserTabSession, untitled: string): string {
  if (tab.title.trim()) return tab.title.trim();
  if (tab.url && tab.url !== BROWSER_HOME_URL) {
    try {
      return new URL(tab.url).hostname || tab.url;
    } catch {
      return tab.url;
    }
  }
  return untitled;
}

const ICON_PROPS = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

function IconBack() {
  return <svg {...ICON_PROPS}><path d="m15 18-6-6 6-6" /></svg>;
}

function IconForward() {
  return <svg {...ICON_PROPS}><path d="m9 18 6-6-6-6" /></svg>;
}

function IconReload() {
  return <svg {...ICON_PROPS}><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg>;
}

function IconStop() {
  return <svg {...ICON_PROPS}><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>;
}

function IconGo() {
  return <svg {...ICON_PROPS}><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></svg>;
}

function IconOpenExternal() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M7 17 17 7" />
      <path d="M8 7h9v9" />
    </svg>
  );
}

function IconGlobe() {
  return (
    <svg {...ICON_PROPS} width={14} height={14}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 0 18" />
      <path d="M12 3a14 14 0 0 0 0 18" />
    </svg>
  );
}

function IconPlus() {
  return <svg {...ICON_PROPS}><path d="M12 5v14M5 12h14" /></svg>;
}

function IconMore() {
  return (
    <svg {...ICON_PROPS}>
      <circle cx="12" cy="5" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="19" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function BrowserView({
  isZh,
  conversationId,
  session,
  onSessionChange,
  claimForeground = true,
  hideTabStrip = false,
  suspendBlank = false,
  lazyTabs = false,
}: BrowserViewProps) {
  const tabsId = useId();
  const mountedTabs = useRef(new Set<string>());
  const availableIds = new Set(session.tabs.map(tab => tab.id));
  for (const id of mountedTabs.current) if (!availableIds.has(id)) mountedTabs.current.delete(id);
  const selected = session.tabs.find(tab => tab.id === session.activeTabId);
  if (selected && !(suspendBlank && selected.url === 'about:blank' && !selected.title)) mountedTabs.current.add(selected.id);
  const renderedTabs = lazyTabs ? session.tabs.filter(tab => mountedTabs.current.has(tab.id)) : session.tabs;
  const handlesRef = useRef(new Map<string, WebviewElement>());
  const navigationRequests = useRef(new Map<string, number>());
  const sessionTabsRef = useRef(session.tabs);
  sessionTabsRef.current = session.tabs;
  const [runtimeByTab, setRuntimeByTab] = useState<Record<string, BrowserTabRuntimeState>>(() =>
    Object.fromEntries(session.tabs.map((tab) => [tab.id, initialRuntime(tab)])),
  );
  const activeTab = session.tabs.find((tab) => tab.id === session.activeTabId) ?? session.tabs[0];
  const activeRuntime = runtimeByTab[activeTab.id] ?? initialRuntime(activeTab);
  const [address, setAddress] = useState(() => displayUrl(activeRuntime.currentUrl));
  const editingRef = useRef(false);
  const composition = useRef(createCompositionGuard());
  const [copying, setCopying] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuNotice, setMenuNotice] = useState<string | null>(null);
  const [importWizardOpen, setImportWizardOpen] = useState(false);
  const [passwordManagerOpen, setPasswordManagerOpen] = useState(false);
  const menuWrapRef = useRef<HTMLDivElement | null>(null);

  const t = useMemo(
    () => ({
      back: isZh ? '后退' : 'Back',
      forward: isZh ? '前进' : 'Forward',
      reload: isZh ? '刷新' : 'Reload',
      stop: isZh ? '停止' : 'Stop',
      go: isZh ? '前往' : 'Go',
      openInDefaultBrowser: isZh ? '用默认浏览器打开' : 'Open in default browser',
      newTab: isZh ? '新建网页标签' : 'New browser tab',
      closeTab: isZh ? '关闭网页标签' : 'Close browser tab',
      untitled: isZh ? '新标签页' : 'New tab',
      placeholder: isZh ? '输入网址或搜索内容，回车前往' : 'Enter URL or search, press Enter',
      loading: isZh ? '加载中…' : 'Loading…',
      failTitle: isZh ? '无法打开此页面' : 'This page can’t be opened',
      retry: isZh ? '重试' : 'Retry',
      blank: isZh ? '空白页 · 输入网址开始浏览' : 'Blank page · type a URL to start',
      more: isZh ? '更多' : 'More',
      menu: isZh ? '浏览器菜单' : 'Browser menu',
      clearConfirm: isZh
        ? '清除当前站点在 Peer Browser 中的 Cookie 与本地数据？不会删除密码库。'
        : 'Clear cookies and site data for this origin in Peer Browser? Password vault is not affected.',
      clearOk: isZh ? '已清除此站点数据' : 'Site data cleared',
      clearFail: isZh ? '清除失败' : 'Failed to clear site data',
      shotOk: isZh ? '截图已保存' : 'Screenshot saved',
      shotFail: isZh ? '截图失败' : 'Screenshot failed',
      shotUnavailable: isZh ? '当前标签页尚未就绪' : 'Current tab is not ready',
      comingSoon: isZh ? '即将推出' : 'Coming soon',
    }),
    [isZh],
  );

  const overflowMenu = useMemo(() => buildBrowserOverflowMenu(isZh), [isZh]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const root = menuWrapRef.current;
      if (root && !root.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!editingRef.current) setAddress(displayUrl(activeRuntime.currentUrl));
  }, [activeRuntime.currentUrl, activeTab.id]);

  const handleHandleChange = useCallback((tabId: string, handle: WebviewElement | null) => {
    if (handle) handlesRef.current.set(tabId, handle);
    else handlesRef.current.delete(tabId);
  }, []);

  const handleMetadataChange = useCallback((
    tabId: string,
    patch: Partial<Pick<BrowserTabSession, 'url' | 'title'>>,
  ) => {
    onSessionChange((current) => updateBrowserTab(current, tabId, patch));
  }, [onSessionChange]);

  const handleRuntimeChange = useCallback((
    tabId: string,
    patch: Partial<BrowserTabRuntimeState>,
  ) => {
    setRuntimeByTab((prev) => {
      const current = prev[tabId]
        ?? initialRuntime(sessionTabsRef.current.find((tab) => tab.id === tabId) ?? createBrowserTabSession(tabId));
      const next = { ...current, ...patch };
      return { ...prev, [tabId]: next };
    });
  }, []);

  const activeWebview = useCallback(
    () => handlesRef.current.get(session.activeTabId) ?? null,
    [session.activeTabId],
  );

  const externalUrl = useMemo(() => {
    const raw = (activeRuntime.currentUrl || address || '').trim();
    if (!raw) return '';
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
      return parsed.toString();
    } catch {
      return '';
    }
  }, [activeRuntime.currentUrl, address]);
  const canOpenExternal = Boolean(externalUrl);

  const handleOpenExternal = useCallback(async () => {
    if (!externalUrl) return;
    const res = await clientApi.openBrowserExternal(externalUrl);
    if (!res?.ok) {
      setMenuNotice(isZh ? '无法用默认浏览器打开' : 'Could not open in default browser');
    }
  }, [externalUrl, isZh]);

  useEffect(() => window.peerAgent?.onBrowserResourceFeedbackNotice?.(notice => {
    const actual = safeGetWebContentsId(activeWebview());
    if (notice.conversationId === conversationId && notice.browserTabId === activeTab.id && notice.webContentsId === actual) setMenuNotice(browserFeedbackNoticeText(notice, isZh));
  }), [conversationId, activeTab.id, activeWebview, isZh]);

  const handleMenuAction = useCallback(
    async (id: BrowserMenuActionId) => {
      setMenuOpen(false);
      setMenuNotice(null);
      if (id === 'import_site_session') {
        setImportWizardOpen(true);
        return;
      }
      if (id === 'password_manager') {
        setPasswordManagerOpen(true);
        return;
      }
      if (id === 'clear_site_data') {
        const url = activeRuntime.currentUrl || '';
        if (!url || url === 'about:blank') {
          setMenuNotice(isZh ? '当前无有效站点可清除' : 'No active site to clear');
          return;
        }
        if (!window.confirm(t.clearConfirm)) return;
        try {
          const res = await clientApi.clearBrowserSiteData(url);
          setMenuNotice(res?.ok ? t.clearOk : `${t.clearFail}${res?.error ? `: ${res.error}` : ''}`);
          if (res?.ok) activeWebview()?.reload();
        } catch (err) {
          setMenuNotice(`${t.clearFail}: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
      if (id === 'screenshot') {
        const handle = activeWebview();
        const webContentsId = safeGetWebContentsId(handle);
        if (!webContentsId) {
          setMenuNotice(t.shotUnavailable);
          return;
        }
        try {
          const res = await clientApi.captureBrowserPage(webContentsId);
          if (res?.ok && res.path) setMenuNotice(`${t.shotOk}: ${res.path}`);
          else if (res?.error === 'cancelled') setMenuNotice(null);
          else setMenuNotice(`${t.shotFail}${res?.error ? `: ${res.error}` : ''}`);
        } catch (err) {
          setMenuNotice(`${t.shotFail}: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
      setMenuNotice(t.comingSoon);
    },
    [activeRuntime.currentUrl, activeWebview, isZh, t],
  );

  const navigate = useCallback((url: string) => {
    const wv = activeWebview();
    if (!wv || !url) return;
    handleRuntimeChange(activeTab.id, { failure: null, reopenedFromUrl: false });
    try {
      const request = (navigationRequests.current.get(activeTab.id) ?? 0) + 1;
      navigationRequests.current.set(activeTab.id, request);
      void wv.loadURL(url).catch((error: unknown) => {
        const failure = error as { code?: string; errno?: number } | null;
        if (failure?.code === 'ERR_ABORTED' || failure?.errno === -3) return;
        if (navigationRequests.current.get(activeTab.id) !== request || handlesRef.current.get(activeTab.id) !== wv) return;
        handleRuntimeChange(activeTab.id, { loading: false, failure: { code: -1, url,
          desc: isZh ? '无法打开此页面，请重试。' : 'Unable to open this page. Please retry.' } });
      });
    } catch {
      wv.src = url;
    }
  }, [activeTab.id, activeWebview, handleRuntimeChange, isZh]);

  const handleSubmit = useCallback(() => {
    const url = normalizeInput(address);
    if (!url) return;
    editingRef.current = false;
    navigate(url);
  }, [address, navigate]);

  const handleAddressKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (composition.current.keyDown(event.nativeEvent)) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      handleSubmit();
    } else if (event.key === 'Escape') {
      editingRef.current = false;
      setAddress(displayUrl(activeRuntime.currentUrl));
      event.currentTarget.blur();
    }
  }, [activeRuntime.currentUrl, handleSubmit]);

  const createTab = useCallback(() => {
    const tab = createBrowserTabSession();
    setRuntimeByTab((prev) => ({ ...prev, [tab.id]: initialRuntime(tab) }));
    onSessionChange((current) => addBrowserTab(current, tab));
  }, [onSessionChange]);

  const selectTab = useCallback((tabId: string) => {
    editingRef.current = false;
    onSessionChange((current) => activateBrowserTab(current, tabId));
  }, [onSessionChange]);

  const removeTab = useCallback((tabId: string) => {
    const replacement = createBrowserTabSession();
    setRuntimeByTab((prev) => {
      const next = { ...prev };
      delete next[tabId];
      if (session.tabs.length === 1) next[replacement.id] = initialRuntime(replacement);
      return next;
    });
    onSessionChange((current) => closeBrowserTab(current, tabId, replacement));
  }, [onSessionChange, session.tabs.length]);

  const tabItems = useMemo(() => session.tabs.map((tab) => ({
    id: tab.id,
    label: tabLabel(tab, t.untitled),
    icon: <IconGlobe />,
  })), [session.tabs, t.untitled]);

  return (
    <div className="browser-view">
      <ResourceTabStrip hidden={hideTabStrip} idPrefix={tabsId}
        ariaLabel={isZh ? '网页标签' : 'Browser tabs'}
        items={tabItems}
        activeId={session.activeTabId}
        closeLabel={t.closeTab}
        onActivate={selectTab}
        onClose={removeTab}
        action={{ label: t.newTab, icon: <IconPlus />, onClick: createTab }}
      />

      <div className="browser-toolbar">
        <div className="browser-nav-group">
          <button
            type="button"
            className="browser-nav-btn"
            title={t.back}
            aria-label={t.back}
            disabled={!activeRuntime.canBack}
            onClick={() => activeWebview()?.goBack()}
          >
            <IconBack />
          </button>
          <button
            type="button"
            className="browser-nav-btn"
            title={t.forward}
            aria-label={t.forward}
            disabled={!activeRuntime.canForward}
            onClick={() => activeWebview()?.goForward()}
          >
            <IconForward />
          </button>
          {activeRuntime.loading ? (
            <button
              type="button"
              className="browser-nav-btn"
              title={t.stop}
              aria-label={t.stop}
              onClick={() => activeWebview()?.stop()}
            >
              <IconStop />
            </button>
          ) : (
            <button
              type="button"
              className="browser-nav-btn"
              title={t.reload}
              aria-label={t.reload}
              onClick={() => activeWebview()?.reload()}
            >
              <IconReload />
            </button>
          )}
        </div>
        <div className="browser-address">
          <input
            type="text"
            className="browser-address-input"
            value={address}
            placeholder={t.placeholder}
            spellCheck={false}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={(event) => {
              editingRef.current = true;
              event.currentTarget.select();
            }}
            onBlur={() => {
              editingRef.current = false;
              setAddress(displayUrl(activeRuntime.currentUrl));
            }}
            onCompositionStart={event => composition.current.start(event.currentTarget)}
            onCompositionEnd={event => composition.current.end(event.currentTarget)}
            onKeyUp={event => composition.current.keyUp(event.nativeEvent)}
            onKeyDown={handleAddressKeyDown}
          />
          <button
            type="button"
            className="browser-go-btn"
            title={t.go}
            aria-label={t.go}
            onClick={handleSubmit}
          >
            <IconGo />
          </button>
        </div>
        <button
          type="button"
          className="browser-nav-btn"
          title={t.openInDefaultBrowser}
          aria-label={t.openInDefaultBrowser}
          disabled={!canOpenExternal}
          onClick={() => void handleOpenExternal()}
        >
          <IconOpenExternal />
        </button>
        {typeof window.peerAgent?.browserWindowCopy === 'function' ? <button type="button" className="browser-nav-btn"
          aria-label={isZh ? '另开网址副本' : 'Open address copy in a new window'} title={isZh ? '另开网址副本，不移动原页面' : 'Open an address copy; keep the original page'}
          disabled={copying || !canOpenExternal || activeRuntime.webContentsId == null || !conversationId}
          onClick={() => {
            const webContentsId = safeGetWebContentsId(activeWebview());
            if (!conversationId || !webContentsId || copying) return;
            setCopying(true);
            void window.peerAgent!.browserWindowCopy!({ conversationId, browserTabId: activeTab.id, webContentsId })
              .then(result => { if (!result.ok) setMenuNotice(result.status === 'limit_reached' ? (isZh ? '独立网页窗口已达上限，请先关闭一个窗口。' : 'Close a browser window before opening another.')
                : (isZh ? '无法另开此页面，原页面保持不变。' : 'Unable to open a copy. The original page is preserved.')); })
              .catch(() => setMenuNotice(isZh ? '暂时无法另开页面，可重试。' : 'Unable to open a copy. Retry.')).finally(() => setCopying(false));
          }}><PeerIcon name="arrowUpRight" size={16} /></button> : null}
        <div className="browser-menu-wrap" ref={menuWrapRef}>
          <button
            type="button"
            className="browser-nav-btn"
            title={t.more}
            aria-label={t.menu}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <IconMore />
          </button>
          <MotionSurface>{menuOpen ? (
            <div className="browser-overflow-menu" role="menu" aria-label={t.menu}>
              {overflowMenu.map((item, index) =>
                item.kind === 'separator' ? (
                  <div key={`sep-${index}`} className="browser-overflow-sep" role="separator" />
                ) : (
                  <button
                    key={item.id}
                    type="button"
                    role="menuitem"
                    className="browser-overflow-item"
                    disabled={!item.enabled}
                    onClick={() => void handleMenuAction(item.id)}
                  >
                    {item.label}
                  </button>
                ),
              )}
            </div>
          ) : null}</MotionSurface>
        </div>
      </div>

      <div className="browser-stage">
        <div className={`browser-progress${activeRuntime.loading ? ' browser-progress--active' : ''}`} />

        {renderedTabs.map((tab) => (
          <BrowserPage isZh={isZh} idPrefix={tabsId}
            key={tab.id}
            tab={tab}
            active={tab.id === session.activeTabId}
            conversationId={conversationId}
            claimForeground={claimForeground}
            onHandleChange={handleHandleChange}
            onMetadataChange={handleMetadataChange}
            onRuntimeChange={handleRuntimeChange}
          />
        ))}

        {activeRuntime.failure ? (
          <div className="browser-error">
            <div className="browser-error-icon"><PeerIcon name="warning" size={32} /></div>
            <div className="browser-error-title">{t.failTitle}</div>
            <div className="browser-error-desc">
              {activeRuntime.failure.desc} ({activeRuntime.failure.code})
            </div>
            {activeRuntime.failure.url ? (
              <div className="browser-error-url">{activeRuntime.failure.url}</div>
            ) : null}
            <button
              type="button"
              className="browser-error-retry"
              onClick={() => navigate(activeRuntime.failure?.url || normalizeInput(address))}
            >
              {t.retry}
            </button>
          </div>
        ) : null}

        {!activeRuntime.failure && activeRuntime.currentUrl === BROWSER_HOME_URL && !activeRuntime.loading ? (
          <div className="browser-blank">{t.blank}</div>
        ) : null}
      </div>

      {activeRuntime.reopenedFromUrl ? <MotionDetails key={activeTab.id} className="browser-recovery-notice">
        <summary><PeerIcon name="chevronRight" size={12} />{isZh ? '按网址恢复的网页' : 'Page restored from URL'}</summary>
        <p>{browserRecoveryDescription(isZh)}</p>
      </MotionDetails> : null}
      <div className="browser-statusbar" data-loading={activeRuntime.loading}>
        <span className="browser-status-text">
          {menuNotice
            ? menuNotice
            : activeRuntime.loading
              ? t.loading
              : activeTab.title || displayUrl(activeRuntime.currentUrl)}
        </span>
      </div>

      <SessionImportWizard
        open={importWizardOpen}
        isZh={isZh}
        onClose={() => setImportWizardOpen(false)}
        onImported={(result) => {
          if (result.ok) {
            setMenuNotice(
              isZh
                ? `已导入 ${result.added ?? 0} 条 Cookie`
                : `Imported ${result.added ?? 0} cookies`,
            );
            activeWebview()?.reload();
          }
        }}
      />

      <PasswordManagerPanel
        open={passwordManagerOpen}
        isZh={isZh}
        pageUrl={activeRuntime.currentUrl}
        webContentsId={activeRuntime.webContentsId}
        onClose={() => setPasswordManagerOpen(false)}
        onStatus={(message) => setMenuNotice(message)}
      />
    </div>
  );
}
