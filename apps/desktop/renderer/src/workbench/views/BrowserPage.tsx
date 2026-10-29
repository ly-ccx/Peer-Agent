import { useCallback, useEffect, useRef, type Ref, type DetailedHTMLProps, type HTMLAttributes } from 'react';
import { clientApi } from '../../clientApi';
import { resourceTabIds } from '../ResourceTabStrip';
import { BROWSER_HOME_URL, type BrowserTabSession } from '../browserSessionState';
import { browserGuestFailure, browserReopensFromUrl } from '../browserRecoveryState';

export interface WebviewElement extends HTMLElement {
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

interface BrowserFailure {
  readonly code: number;
  readonly desc: string;
  readonly url: string;
}

export interface BrowserTabRuntimeState {
  readonly currentUrl: string;
  readonly loading: boolean;
  readonly canBack: boolean;
  readonly canForward: boolean;
  readonly failure: BrowserFailure | null;
  /** guest webContents id；仅在 webview dom-ready 后可用。 */
  readonly webContentsId: number | null;
  readonly reopenedFromUrl: boolean;
}

interface BrowserPageProps {
  readonly isZh?: boolean;
  readonly idPrefix: string;
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

export function initialRuntime(tab: BrowserTabSession): BrowserTabRuntimeState {
  return {
    currentUrl: tab.url || BROWSER_HOME_URL,
    loading: false,
    canBack: false,
    canForward: false,
    failure: null,
    webContentsId: null,
    reopenedFromUrl: browserReopensFromUrl(tab),
  };
}

/** webview guest API：未 attach / 未 dom-ready 时会 throw，不能直接在 render 里调。 */
export function safeGetWebContentsId(wv: WebviewElement | null | undefined): number | null {
  if (!wv) return null;
  try {
    const id = wv.getWebContentsId();
    if (!Number.isInteger(id) || id <= 0) return null;
    return id;
  } catch {
    return null;
  }
}

export function BrowserPage({
  isZh = false,
  idPrefix,
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
  const guestGoneRef = useRef(false);
  const currentUrlRef = useRef(tab.url);
  currentUrlRef.current = tab.url;
  const activeRef = useRef(active);
  activeRef.current = active;

  const publishRegistration = useCallback((isActive = activeRef.current, metadataOnly = true) => {
    const wv = webviewRef.current;
    if (!wv || guestGoneRef.current) return;
    const webContentsId = safeGetWebContentsId(wv);
    if (webContentsId == null) return;
    registeredIdRef.current = webContentsId;
    onRuntimeChange(tab.id, { webContentsId });
    try {
      void clientApi.registerBrowserWebContents({
        webContentsId,
        metadataOnly,
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
    const onGuestGone = (event: Event) => {
      guestGoneRef.current = true;
      const reason = (event as unknown as { details?: { reason?: string } }).details?.reason;
      onRuntimeChange(tab.id, { loading: false, webContentsId: null,
        failure: browserGuestFailure(reason, currentUrlRef.current, isZh) });
      if (registeredIdRef.current != null) {
        void clientApi.unregisterBrowserWebContents({ webContentsId: registeredIdRef.current,
          conversationId, browserTabId: tab.id }).catch(() => {});
        registeredIdRef.current = null;
      }
    };
    const onDomReady = () => {
      guestGoneRef.current = false;
      updateUrl();
      onMetadataChange(tab.id, { title: wv.getTitle() });
      publishRegistration();
    };

    const onFocus = () => publishRegistration(activeRef.current, false);
    wv.addEventListener('focus', onFocus);
    wv.addEventListener('did-start-loading', onStartLoading);
    wv.addEventListener('did-stop-loading', onStopLoading);
    wv.addEventListener('did-navigate', updateUrl);
    wv.addEventListener('did-navigate-in-page', updateUrl);
    wv.addEventListener('page-title-updated', onTitle);
    wv.addEventListener('did-fail-load', onFailLoad);
    wv.addEventListener('dom-ready', onDomReady);
    wv.addEventListener('render-process-gone', onGuestGone);

    return () => {
      wv.removeEventListener('focus', onFocus);
      wv.removeEventListener('did-start-loading', onStartLoading);
      wv.removeEventListener('did-stop-loading', onStopLoading);
      wv.removeEventListener('did-navigate', updateUrl);
      wv.removeEventListener('did-navigate-in-page', updateUrl);
      wv.removeEventListener('page-title-updated', onTitle);
      wv.removeEventListener('did-fail-load', onFailLoad);
      wv.removeEventListener('dom-ready', onDomReady);
      wv.removeEventListener('render-process-gone', onGuestGone);
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
    isZh,
    conversationId,
    onHandleChange,
    onMetadataChange,
    onRuntimeChange,
    publishRegistration,
    tab.id,
  ]);

  useEffect(() => {
    publishRegistration(active, !(active && claimForeground));
  }, [active, claimForeground, publishRegistration]);

  return (
    <webview
      ref={webviewRef as unknown as Ref<HTMLElement>}
      className="browser-webview"
      id={resourceTabIds(idPrefix, tab.id).panel} role="tabpanel" aria-labelledby={resourceTabIds(idPrefix, tab.id).tab}
      tabIndex={active ? 0 : -1} aria-hidden={!active} inert={!active}
      data-active={active}
      src={initialUrlRef.current}
      partition={BROWSER_PARTITION}
    />
  );
}
