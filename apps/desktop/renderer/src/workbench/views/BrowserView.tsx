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
import { getBrowserSessionUrl, setBrowserSessionUrl } from '../browserSessionState';

// ── <webview> 类型声明 ────────────────────────────────────────────────
// Electron 的 <webview> 标签不是标准 JSX 元素，这里补一个最小可用的内联声明，
// 仅覆盖本组件用到的属性/方法，避免引入额外类型依赖。
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
  readonly useragent?: string;
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
}

// 会话隔离：浏览器面板使用独立的持久化分区，与主应用 cookie/storage 互不污染。
const BROWSER_PARTITION = 'persist:peer-browser';
const HOME_URL = 'about:blank';

// 把用户在地址栏输入的内容规范化为可导航的 URL：
// - 已带协议的原样使用
// - 形似域名/带路径的补 https://
// - 其它一律当作搜索词，走必应搜索
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

// 把内部 URL 显示为更干净的地址（about:blank 显示为空）。
function displayUrl(url: string): string {
  if (!url || url === 'about:blank') return '';
  return url;
}

// ── 工具栏图标 ────────────────────────────────────────────────────────
// 复用项目既有的内联 SVG 范式（见 WorkbenchPanel.tsx）：24x24 viewBox、
// fill=none、stroke=currentColor、线宽 2、圆角线帽，跟随当前文字色。
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
  return (
    <svg {...ICON_PROPS}>
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

function IconForward() {
  return (
    <svg {...ICON_PROPS}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function IconReload() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

function IconStop() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function IconGo() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  );
}

export function BrowserView({ isZh, conversationId }: BrowserViewProps) {
  const initialUrl = getBrowserSessionUrl(conversationId);
  const webviewRef = useRef<WebviewElement | null>(null);
  const [address, setAddress] = useState(() => displayUrl(initialUrl));
  const [currentUrl, setCurrentUrl] = useState(initialUrl);
  const [title, setTitle] = useState('');
  const [loading, setLoading] = useState(false);
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);
  const [failure, setFailure] = useState<{ code: number; desc: string; url: string } | null>(
    null,
  );
  // 地址栏聚焦时不被导航事件回写覆盖，避免“打字被打断”。用 ref 追踪，不触发重渲染。
  const editingRef = useRef(false);

  const t = useMemo(
    () => ({
      back: isZh ? '后退' : 'Back',
      forward: isZh ? '前进' : 'Forward',
      reload: isZh ? '刷新' : 'Reload',
      stop: isZh ? '停止' : 'Stop',
      go: isZh ? '前往' : 'Go',
      placeholder: isZh ? '输入网址或搜索内容，回车前往' : 'Enter URL or search, press Enter',
      loading: isZh ? '加载中…' : 'Loading…',
      failTitle: isZh ? '无法打开此页面' : 'This page can’t be opened',
      retry: isZh ? '重试' : 'Retry',
      blank: isZh ? '空白页 · 输入网址开始浏览' : 'Blank page · type a URL to start',
    }),
    [isZh],
  );

  const syncNavState = useCallback(() => {
    const wv = webviewRef.current;
    if (!wv) return;
    try {
      setCanBack(wv.canGoBack());
      setCanForward(wv.canGoForward());
    } catch {
      /* webview 尚未就绪，忽略 */
    }
  }, []);

  const navigate = useCallback((url: string) => {
    const wv = webviewRef.current;
    if (!wv || !url) return;
    setFailure(null);
    try {
      void wv.loadURL(url);
    } catch {
      wv.src = url;
    }
  }, []);

  const handleSubmit = useCallback(() => {
    const url = normalizeInput(address);
    if (!url) return;
    editingRef.current = false;
    navigate(url);
  }, [address, navigate]);

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSubmit();
      } else if (e.key === 'Escape') {
        editingRef.current = false;
        setAddress(displayUrl(currentUrl));
        e.currentTarget.blur();
      }
    },
    [handleSubmit, currentUrl],
  );

  // 绑定 webview 事件：导航/标题/加载态/失败兜底。
  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;

    const onStartLoading = () => {
      setLoading(true);
      setFailure(null);
    };
    const onStopLoading = () => {
      setLoading(false);
      syncNavState();
    };
    const updateUrl = () => {
      const url = wv.getURL();
      setCurrentUrl(url);
      setBrowserSessionUrl(conversationId, url);
      // 仅在用户未编辑地址栏时才回写，避免打断输入。
      if (!editingRef.current) setAddress(displayUrl(url));
      syncNavState();
    };
    const onTitle = (e: Event) => {
      const detail = (e as unknown as { title?: string }).title;
      setTitle(detail ?? wv.getTitle());
    };
    const onFailLoad = (e: Event) => {
      const ev = e as unknown as {
        errorCode: number;
        errorDescription: string;
        validatedURL: string;
        isMainFrame: boolean;
      };
      // 仅对主框架失败兜底；子资源失败（广告/统计等）忽略。-3 = ABORTED（用户停止/重定向）忽略。
      if (ev.isMainFrame === false) return;
      if (ev.errorCode === -3) return;
      setLoading(false);
      setFailure({ code: ev.errorCode, desc: ev.errorDescription, url: ev.validatedURL });
    };

    // dom-ready：同步导航态 + 把本 webview 的 webContentsId 上报给 main（见 ADR 40），
    // 使 Agent 的 browser_* 工具能经 webContents.fromId 直接操控这同一个可见浏览器。
    let registeredId: number | null = null;
    const onDomReady = () => {
      syncNavState();
      try {
        const id = wv.getWebContentsId();
        if (Number.isInteger(id) && id > 0) {
          registeredId = id;
          void clientApi.registerBrowserWebContents(id, wv.getURL(), wv.getTitle());
        }
      } catch {
        /* 非 Electron 环境或句柄未就绪 → Agent 操控将在未注册时报错兜底 */
      }
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
      if (registeredId != null) {
        try {
          void clientApi.unregisterBrowserWebContents(registeredId);
        } catch {
          /* 忽略注销异常 */
        }
      }
    };
  }, [conversationId, syncNavState]);

  return (
    <div className="browser-view">
      <div className="browser-toolbar">
        <div className="browser-nav-group">
          <button
            type="button"
            className="browser-nav-btn"
            title={t.back}
            aria-label={t.back}
            disabled={!canBack}
            onClick={() => webviewRef.current?.goBack()}
          >
            <IconBack />
          </button>
          <button
            type="button"
            className="browser-nav-btn"
            title={t.forward}
            aria-label={t.forward}
            disabled={!canForward}
            onClick={() => webviewRef.current?.goForward()}
          >
            <IconForward />
          </button>
          {loading ? (
            <button
              type="button"
              className="browser-nav-btn"
              title={t.stop}
              aria-label={t.stop}
              onClick={() => webviewRef.current?.stop()}
            >
              <IconStop />
            </button>
          ) : (
            <button
              type="button"
              className="browser-nav-btn"
              title={t.reload}
              aria-label={t.reload}
              onClick={() => webviewRef.current?.reload()}
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
            onChange={(e) => setAddress(e.target.value)}
            onFocus={(e) => {
              editingRef.current = true;
              e.currentTarget.select();
            }}
            onBlur={() => {
              editingRef.current = false;
              setAddress(displayUrl(currentUrl));
            }}
            onKeyDown={handleKeyDown}
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
      </div>

      <div className="browser-stage">
        <div className={`browser-progress${loading ? ' browser-progress--active' : ''}`} />

        <webview
          ref={webviewRef as unknown as Ref<HTMLElement>}
          className="browser-webview"
          src={initialUrl}
          partition={BROWSER_PARTITION}
        />

        {failure ? (
          <div className="browser-error">
            <div className="browser-error-icon">⚠️</div>
            <div className="browser-error-title">{t.failTitle}</div>
            <div className="browser-error-desc">
              {failure.desc} ({failure.code})
            </div>
            {failure.url ? <div className="browser-error-url">{failure.url}</div> : null}
            <button
              type="button"
              className="browser-error-retry"
              onClick={() => navigate(failure.url || normalizeInput(address))}
            >
              {t.retry}
            </button>
          </div>
        ) : null}

        {!failure && currentUrl === 'about:blank' && !loading ? (
          <div className="browser-blank">{t.blank}</div>
        ) : null}
      </div>

      <div className="browser-statusbar" data-loading={loading}>
        <span className="browser-status-text">
          {loading ? t.loading : title || displayUrl(currentUrl)}
        </span>
      </div>
    </div>
  );
}
