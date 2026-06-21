/**
 * Web fetch 引擎 —— 见 ADR 38（local.web.fetch）。
 *
 * 职责（Depth：高杠杆藏在小接口后）：
 *   fetchWebPage({ url, waitForRender, timeoutMs }) -> {
 *     ok, finalUrl, title, content, contentType, httpStatus, fetchMode, error?
 *   }
 *
 * 实现要点（与 AGENTS.md 硬性约束一致）：
 * - 在 Electron 主进程用隐藏 BrowserWindow 加载页面，等待渲染完成后用
 *   webContents.executeJavaScript 在页面上下文抽取正文（标题 + 可读文本）。
 *   这覆盖 JS 驱动的动态站点。
 * - 若 BrowserWindow 不可用（例如非 Electron 运行/单测）或加载失败，退化为
 *   内置 fetch 的静态 HTTP GET + 朴素 HTML 去标签，保证最小可用。
 * - 不向 renderer 暴露 BrowserWindow / 网络原语；该模块仅在 main 进程被 Provider 调用。
 *
 * 该模块只做「抓取 + 抽正文」，不负责权限判定、不负责 artifact 落盘、不负责
 * Evidence 组装 —— 那些由 local-web-provider 经正规运行时链路处理。
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_CONTENT_CHARS = 2_000_000;

function normalizeUrl(rawUrl) {
  const url = String(rawUrl ?? '').trim();
  if (!url) return { ok: false, error: 'empty_url' };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'invalid_url' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'unsupported_protocol' };
  }
  return { ok: true, url: parsed.toString() };
}

// 在页面上下文执行的正文抽取脚本。返回 { title, content }。
// 朴素 readability：去掉 script/style/nav/footer/aside，取 body 文本并压缩空白。
function buildExtractionScript() {
  return `(() => {
    try {
      const clone = document.cloneNode(true);
      const drop = clone.querySelectorAll('script,style,noscript,iframe,svg,canvas,nav,footer,aside,header');
      drop.forEach((el) => el.remove());
      const title = (document.title || '').trim();
      const main = clone.querySelector('main, article, [role=main]') || clone.body || clone.documentElement;
      const raw = (main && main.innerText) ? main.innerText : '';
      const content = raw.replace(/[\\t\\f\\r ]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim();
      return { title, content };
    } catch (err) {
      return { title: (document.title || '').trim(), content: '', error: String(err && err.message || err) };
    }
  })();`;
}

function stripHtml(html) {
  const text = String(html ?? '');
  const withoutHead = text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  const titleMatch = withoutHead.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '';
  const content = withoutHead
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[\t\f\r ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, content };
}

function capContent(value) {
  const text = String(value ?? '');
  if (text.length <= MAX_CONTENT_CHARS) return text;
  return `${text.slice(0, MAX_CONTENT_CHARS)}\n...[content truncated]`;
}

async function loadElectronBrowserWindow() {
  try {
    const electron = await import('electron');
    return electron.BrowserWindow ?? electron.default?.BrowserWindow ?? null;
  } catch {
    return null;
  }
}

async function fetchViaBrowserWindow({ BrowserWindow, url, waitForRender, timeoutMs }) {
  let win = null;
  try {
    win = new BrowserWindow({
      show: false,
      webPreferences: {
        offscreen: true,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        javascript: true,
        images: false,
      },
    });

    const wc = win.webContents;
    wc.setAudioMuted(true);

    const navigation = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('navigation_timeout')), timeoutMs);
      wc.once('did-finish-load', () => {
        clearTimeout(timer);
        resolve();
      });
      wc.once('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
        // 子frame失败忽略；主frame失败才算失败。
        if (!isMainFrame) return;
        clearTimeout(timer);
        reject(new Error(`did_fail_load:${errorCode}:${errorDescription}`));
      });
    });

    await wc.loadURL(url);
    await navigation;

    if (waitForRender) {
      // 给 client-side rendering 一点额外时间稳定 DOM。
      await new Promise((r) => setTimeout(r, 800));
    }

    const extracted = await wc.executeJavaScript(buildExtractionScript(), true);
    const finalUrl = wc.getURL() || url;
    return {
      ok: true,
      finalUrl,
      title: String(extracted?.title ?? '').trim(),
      content: capContent(extracted?.content ?? ''),
      contentType: 'text/html',
      httpStatus: 200,
      fetchMode: 'browser',
    };
  } finally {
    if (win && !win.isDestroyed()) {
      win.destroy();
    }
  }
}

async function fetchViaHttp({ url, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) PeerAgent/1.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    const contentType = res.headers.get('content-type') || 'text/html';
    const body = await res.text();
    const isHtml = contentType.includes('html');
    const { title, content } = isHtml ? stripHtml(body) : { title: '', content: body };
    return {
      ok: res.ok,
      finalUrl: res.url || url,
      title,
      content: capContent(content),
      contentType,
      httpStatus: res.status,
      fetchMode: 'http',
      error: res.ok ? undefined : `http_status_${res.status}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchWebPage({
  url,
  waitForRender = true,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  browserWindowLoader = loadElectronBrowserWindow,
  httpFetcher = fetchViaHttp,
} = {}) {
  const normalized = normalizeUrl(url);
  if (!normalized.ok) {
    return { ok: false, fetchMode: 'none', error: normalized.error };
  }
  const safeUrl = normalized.url;
  const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

  const BrowserWindow = await browserWindowLoader();
  if (BrowserWindow) {
    try {
      return await fetchViaBrowserWindow({
        BrowserWindow,
        url: safeUrl,
        waitForRender,
        timeoutMs: effectiveTimeout,
      });
    } catch (browserError) {
      // 浏览器窗口加载失败 → 退化静态 HTTP GET。
      try {
        const httpResult = await httpFetcher({ url: safeUrl, timeoutMs: effectiveTimeout });
        return { ...httpResult, fetchMode: 'http_fallback', browserError: String(browserError?.message ?? browserError) };
      } catch (httpError) {
        return {
          ok: false,
          fetchMode: 'failed',
          error: `browser_and_http_failed:${String(httpError?.message ?? httpError)}`,
          browserError: String(browserError?.message ?? browserError),
        };
      }
    }
  }

  // 无 BrowserWindow（非 Electron / 单测）→ 直接静态 HTTP GET。
  try {
    return await httpFetcher({ url: safeUrl, timeoutMs: effectiveTimeout });
  } catch (httpError) {
    return { ok: false, fetchMode: 'failed', error: String(httpError?.message ?? httpError) };
  }
}

export const __test__ = { normalizeUrl, stripHtml, capContent };
