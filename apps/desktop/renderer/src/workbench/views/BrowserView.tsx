import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DetailedHTMLProps,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type Ref,
} from 'react';
import { clientApi } from '../../clientApi';
import { ResourceTabStrip } from '../ResourceTabStrip';
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

interface WebviewElement extends HTMLElement {
  src: string;
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  goBack(): void;
  goForward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  reload(): void;
  stop(): void;
  getWebContentsId(): number;
}

interface WebviewProps
  extends DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> {
  readonly src?: string;
  readonly partition?: string;
  readonly allowpopups?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      webview: WebviewProps;
    }
  }
}

interface BrowserViewProps {
  readonly isZh: boolean;
  readonly conversationId: string | null;
  readonly session: BrowserSessionState;
  readonly onSessionChange: (
    next: BrowserSessionState | ((current: BrowserSessionState) => BrowserSessionState),
  ) => void;
  /** 只有前台可见会话才能改窗口菜单绑定的 Browser 目标。 */
  readonly claimForeground?: boolean;
}

interface BrowserFailure {
  readonly code: number;
  readonly desc: string;
  readonly url: string;
}

interface BrowserTabRuntimeState {
  readonly currentUrl: string;
  readonly loading: boolean;
  readonly canBack: boolean;
  readonly canForward: boolean;
  readonly failure: BrowserFailure | null;
  /** guest webContents id；仅在 webview dom-ready 后可用。 */
  readonly webContentsId: number | null;
}

interface BrowserPageProps {
  readonly tab: BrowserTabSession;
  readonly active: boolean;
  readonly conversationId: string | null;
  readonly claimForeground?: boolean;
  readonly onHandleChange: (tabId: string, handle: WebviewElement | null) => void;
  readonly onMetadataChange: (
    tabId: string,
    patch: Partial<Pick<BrowserTabSession, 'url' | 'title'>>,
  ) => void;
  readonly onRuntimeChange: (tabId: string, patch: Partial<BrowserTabRuntimeState>) => void;
}

// Cookie / localStorage 在所有会话和标签间共享，浏览器身份与主应用 renderer 隔离。
const BROWSER_PARTITION = 'persist:peer-browser';

function initialRuntime(tab: BrowserTabSession): BrowserTabRuntimeState {
  return {
    currentUrl: tab.url || BROWSER_HOME_URL,
    loading: false,
    canBack: false,
    canForward: false,
    failure: null,
    webContentsId: null,
  };
}

/** webview guest API：未 attach / 未 dom-ready 时会 throw，不能直接在 render 里调。 */
function safeGetWebContentsId(wv: WebviewElement | null | undefined): number | null {
  if (!wv) return null;
  try {
    const id = wv.getWebContentsId();
    if (!Number.isInteger(id) || id <= 0) return null;
    return id;
  } catch {
    return null;
  }
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

function BrowserPage({
  tab,
  active,
  conversationId,
  claimForeground = true,
  onHandleChange,
  onMetadataChange,
  onRuntimeChange,
}: BrowserPageProps) {
  const webviewRef = useRef<WebviewElement | null>(null);
  // src 只负责 guest 首次挂载；后续导航由 WebContents 自己维护，避免 redirect 后
  // 元数据回写再次改 src，造成重复加载和 history 被重置。
  const initialUrlRef = useRef(tab.url || BROWSER_HOME_URL);
  const registeredIdRef = useRef<number | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  const publishRegistration = useCallback((isActive = activeRef.current) => {
    const wv = webviewRef.current;
    if (!wv) return;
    const webContentsId = safeGetWebContentsId(wv);
    if (webContentsId == null) return;
    registeredIdRef.current = webContentsId;
    onRuntimeChange(tab.id, { webContentsId });
    try {
      void clientApi.registerBrowserWebContents({
        webContentsId,
        conversationId,
        browserTabId: tab.id,
        active: isActive,
        claimForeground,
        url: wv.getURL(),
        title: wv.getTitle(),
      }).catch(() => {});
    } catch {
      // 非 Electron 环境或 guest 尚未就绪，dom-ready 后会再次发布。
    }
  }, [claimForeground, conversationId, onRuntimeChange, tab.id]);

  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;
    onHandleChange(tab.id, wv);

    const syncNavState = () => {
      try {
        onRuntimeChange(tab.id, {
          canBack: wv.canGoBack(),
          canForward: wv.canGoForward(),
        });
      } catch {
        // guest 尚未就绪。
      }
    };
    const updateUrl = () => {
      const url = wv.getURL() || BROWSER_HOME_URL;
      onRuntimeChange(tab.id, { currentUrl: url });
      onMetadataChange(tab.id, { url });
      syncNavState();
      publishRegistration();
    };
    const onStartLoading = () => {
      onRuntimeChange(tab.id, { loading: true, failure: null });
    };
    const onStopLoading = () => {
      onRuntimeChange(tab.id, { loading: false });
      syncNavState();
      publishRegistration();
    };
    const onTitle = (event: Event) => {
      const detail = (event as unknown as { title?: string }).title;
      onMetadataChange(tab.id, { title: detail ?? wv.getTitle() });
      publishRegistration();
    };
    const onFailLoad = (event: Event) => {
      const ev = event as unknown as {
        errorCode: number;
        errorDescription: string;
        validatedURL: string;
        isMainFrame: boolean;
      };
      if (ev.isMainFrame === false || ev.errorCode === -3) return;
      onRuntimeChange(tab.id, {
        loading: false,
        failure: { code: ev.errorCode, desc: ev.errorDescription, url: ev.validatedURL },
      });
    };
    const onDomReady = () => {
      updateUrl();
      onMetadataChange(tab.id, { title: wv.getTitle() });
      publishRegistration();
    };

    wv.addEventListener('did-start-loading', onStartLoading);
    wv.addEventListener('did-stop-loading', onStopLoading);
    wv.addEventListener('did-navigate', updateUrl);
    wv.addEventListener('did-navigate-in-page', updateUrl);
    wv.addEventListener('page-title-updated', onTitle);
    wv.addEventListener('did-fail-load', onFailLoad);
    wv.addEventListener('dom-ready', onDomReady);

    return () => {
      wv.removeEventListener('did-start-loading', onStartLoading);
      wv.removeEventListener('did-stop-loading', onStopLoading);
      wv.removeEventListener('did-navigate', updateUrl);
      wv.removeEventListener('did-navigate-in-page', updateUrl);
      wv.removeEventListener('page-title-updated', onTitle);
      wv.removeEventListener('did-fail-load', onFailLoad);
      wv.removeEventListener('dom-ready', onDomReady);
      onHandleChange(tab.id, null);
      onRuntimeChange(tab.id, { webContentsId: null });
      if (registeredIdRef.current != null) {
        void clientApi.unregisterBrowserWebContents({
          webContentsId: registeredIdRef.current,
          conversationId,
          browserTabId: tab.id,
        }).catch(() => {});
      }
    };
  }, [
    conversationId,
    onHandleChange,
    onMetadataChange,
    onRuntimeChange,
    publishRegistration,
    tab.id,
  ]);

  useEffect(() => {
    if (active) publishRegistration(true);
  }, [active, publishRegistration]);

  return (
    <webview
      ref={webviewRef as unknown as Ref<HTMLElement>}
      className="browser-webview"
      data-active={active}
      src={initialUrlRef.current}
      partition={BROWSER_PARTITION}
    />
  );
}

export function BrowserView({
  isZh,
  conversationId,
  session,
  onSessionChange,
  claimForeground = true,
}: BrowserViewProps) {
  const handlesRef = useRef(new Map<string, WebviewElement>());
  const sessionTabsRef = useRef(session.tabs);
  sessionTabsRef.current = session.tabs;
  const [runtimeByTab, setRuntimeByTab] = useState<Record<string, BrowserTabRuntimeState>>(() =>
    Object.fromEntries(session.tabs.map((tab) => [tab.id, initialRuntime(tab)])),
  );
  const activeTab = session.tabs.find((tab) => tab.id === session.activeTabId) ?? session.tabs[0];
  const activeRuntime = runtimeByTab[activeTab.id] ?? initialRuntime(activeTab);
  const [address, setAddress] = useState(() => displayUrl(activeRuntime.currentUrl));
  const editingRef = useRef(false);
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
    handleRuntimeChange(activeTab.id, { failure: null });
    try {
      void wv.loadURL(url);
    } catch {
      wv.src = url;
    }
  }, [activeTab.id, activeWebview, handleRuntimeChange]);

  const handleSubmit = useCallback(() => {
    const url = normalizeInput(address);
    if (!url) return;
    editingRef.current = false;
    navigate(url);
  }, [address, navigate]);

  const handleAddressKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
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
      <ResourceTabStrip
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
          {menuOpen ? (
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
          ) : null}
        </div>
      </div>

      <div className="browser-stage">
        <div className={`browser-progress${activeRuntime.loading ? ' browser-progress--active' : ''}`} />

        {session.tabs.map((tab) => (
          <BrowserPage
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
            <div className="browser-error-icon">⚠️</div>
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
