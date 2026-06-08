import { BrowserWindow, session } from 'electron';

const DINGTALK_PARTITION = 'persist:dingtalk';
const DINGTALK_AIHUB_BASE = 'https://aihub.dingtalk.com';
const DINGTALK_CLIENT_ID = 'dingbakuoyxavyp5ruxw';
const DINGTALK_AUTH_BASE = 'https://login.dingtalk.com/oauth2/auth';
const DINGTALK_ACTIVATE_URL = `${DINGTALK_AIHUB_BASE}/mcp/used/activate`;
const DINGTALK_LOGIN_CONTINUE_URL = `${DINGTALK_AIHUB_BASE}/`;
const LOGIN_CHECK_INTERVAL_MS = 500;
const LOGIN_CHECK_MAX_ATTEMPTS = 120;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

let apiWindow = null;
let authValidated = false;

function getDingtalkSession() {
  return session.fromPartition(DINGTALK_PARTITION);
}

async function hasDingtalkAuth() {
  if (authValidated) return true;
  return hasDingtalkLoginCookies();
}

async function hasDingtalkLoginCookies() {
  const cookies = await getDingtalkSession().cookies.get({ url: DINGTALK_AIHUB_BASE });
  const names = cookies.map((cookie) => cookie.name);
  if (names.includes('corp_id') || names.includes('cs_client_mark')) return true;

  const allCookies = await getDingtalkSession().cookies.get({});
  const allNames = allCookies.map((cookie) => cookie.name);
  return allNames.includes('corp_id') || allNames.includes('cs_client_mark');
}

function buildDingtalkLoginUrl(continueUrl = DINGTALK_LOGIN_CONTINUE_URL) {
  const redirectUri = `${DINGTALK_AIHUB_BASE}/dingtalk_sso_call_back?continue=${encodeURIComponent(continueUrl)}`;
  const params = new URLSearchParams({
    redirect_uri: redirectUri,
    response_type: 'code',
    client_id: DINGTALK_CLIENT_ID,
    scope: 'openid corpid',
  });
  return `${DINGTALK_AUTH_BASE}?${params.toString()}`;
}

function normalizeDingtalkLoginUrl(loginUrl) {
  try {
    const parsed = new URL(loginUrl);
    if (!isLoginUrl(parsed.toString())) return buildDingtalkLoginUrl();
    const redirectUri = `${DINGTALK_AIHUB_BASE}/dingtalk_sso_call_back?continue=${encodeURIComponent(DINGTALK_LOGIN_CONTINUE_URL)}`;
    parsed.searchParams.set('redirect_uri', redirectUri);
    parsed.searchParams.set('response_type', 'code');
    parsed.searchParams.set('client_id', DINGTALK_CLIENT_ID);
    parsed.searchParams.set('scope', 'openid corpid');
    return parsed.toString();
  } catch {
    return buildDingtalkLoginUrl();
  }
}

function isLoginUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.hostname === 'login.dingtalk.com' || parsed.hostname.endsWith('.login.dingtalk.com');
  } catch {
    return false;
  }
}

function resolveRedirectUrl(location, baseUrl) {
  if (!location) return '';
  try {
    return new URL(location, baseUrl).toString();
  } catch {
    return location;
  }
}

function isRedirectCancelled(err) {
  return err instanceof Error && err.message === 'Redirect was cancelled';
}

function openDingtalkLogin({ loginUrl = buildDingtalkLoginUrl() } = {}) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 420,
      height: 520,
      title: '登录钉钉',
      webPreferences: {
        partition: DINGTALK_PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    win.setMenuBarVisibility(false);

    let resolved = false;
    let landedOnAihub = false;
    let authCheckStarted = false;

    const finish = (success) => {
      if (resolved) return;
      resolved = true;
      if (success) {
        authValidated = true;
        apiWindow = win;
        if (!win.isDestroyed()) {
          win.setSkipTaskbar(true);
          win.hide();
        }
      } else if (!win.isDestroyed()) {
        win.close();
      }
      resolve(success);
    };

    const checkAuth = async () => {
      if (authCheckStarted) return;
      authCheckStarted = true;
      for (let i = 0; i < LOGIN_CHECK_MAX_ATTEMPTS && !resolved; i += 1) {
        await new Promise((r) => setTimeout(r, LOGIN_CHECK_INTERVAL_MS));
        const cookies = await getDingtalkSession().cookies.get({});
        const names = cookies.map((c) => c.name);
        console.log('[dingtalk-login] waiting for auth, attempt', i + 1, ':', names.join(', '));
        if (await hasDingtalkLoginCookies()) {
          finish(true);
          return;
        }
      }
      finish(false);
    };

    win.webContents.on('did-navigate', () => {
      const url = win.webContents.getURL();
      if (url.startsWith(DINGTALK_AIHUB_BASE)) {
        landedOnAihub = true;
      }
    });

    win.webContents.on('did-finish-load', () => {
      if (!landedOnAihub || resolved) return;
      void checkAuth();
    });

    win.on('closed', () => {
      if (apiWindow === win) apiWindow = null;
      finish(false);
    });

    void win.loadURL(loginUrl);
  });
}

async function dingtalkFetch(url, options = {}) {
  if (apiWindow && !apiWindow.isDestroyed() && apiWindow.webContents.getURL().startsWith(DINGTALK_AIHUB_BASE)) {
    return dingtalkPageFetch(url, options);
  }

  return dingtalkSessionFetch(url, options);
}

async function dingtalkSessionFetch(url, options = {}) {
  let response;
  try {
    response = await getDingtalkSession().fetch(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body,
      credentials: 'include',
      redirect: 'manual',
    });
  } catch (err) {
    if (isRedirectCancelled(err)) {
      return {
        loginRequired: true,
        loginUrl: buildDingtalkLoginUrl(),
        status: 0,
        text: '',
      };
    }
    throw err;
  }

  const redirectUrl = resolveRedirectUrl(response.headers.get('location'), url);
  if (REDIRECT_STATUSES.has(response.status) && isLoginUrl(redirectUrl)) {
    return {
      loginRequired: true,
      loginUrl: redirectUrl,
      status: response.status,
      text: '',
    };
  }

  const text = await response.text();
  return {
    loginRequired: false,
    loginUrl: '',
    ok: response.ok,
    status: response.status,
    text,
  };
}

async function dingtalkPageFetch(url, options = {}) {
  const script = `
    (async () => {
      try {
        const response = await fetch(${JSON.stringify(url)}, {
          method: ${JSON.stringify(options.method || 'GET')},
          headers: ${JSON.stringify(options.headers || {})},
          body: ${options.body ? JSON.stringify(options.body) : 'undefined'},
          credentials: 'include',
        });
        return {
          fetchError: '',
          ok: response.ok,
          redirected: response.redirected,
          status: response.status,
          url: response.url,
          text: await response.text(),
        };
      } catch (err) {
        return {
          fetchError: err instanceof Error ? err.message : String(err),
          ok: false,
          redirected: false,
          status: 0,
          url: '',
          text: '',
        };
      }
    })()
  `;
  const result = await apiWindow.webContents.executeJavaScript(script);
  const responseUrl = typeof result?.url === 'string' ? result.url : '';
  if (result?.fetchError || isLoginUrl(responseUrl)) {
    return {
      loginRequired: true,
      loginUrl: buildDingtalkLoginUrl(),
      ok: false,
      status: Number(result?.status) || 0,
      text: '',
    };
  }

  return {
    loginRequired: false,
    loginUrl: '',
    ok: Boolean(result?.ok),
    status: Number(result?.status) || 0,
    text: typeof result?.text === 'string' ? result.text : '',
  };
}

function parseDingtalkJson(text) {
  if (text.startsWith('<!') || text.startsWith('<html')) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function assertActivationSuccess(data) {
  if (!data?.success) {
    throw new Error(data?.errorMsg || '激活 MCP 失败');
  }
  authValidated = true;
  return data;
}

export function createDingtalkAuthService() {
  async function ensureAuth() {
    if (await hasDingtalkAuth()) return true;
    return openDingtalkLogin();
  }

  async function activate(mcpId) {
    const tryActivate = async ({ logErrors = true } = {}) => {
      try {
        const result = await dingtalkFetch(DINGTALK_ACTIVATE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `mcpId=${encodeURIComponent(mcpId)}&source=MARKET`,
        });

        if (result.loginRequired) {
          const loginUrl = normalizeDingtalkLoginUrl(result.loginUrl);
          console.log('[dingtalk-activate] login required:', loginUrl);
          return { loginRequired: true, loginUrl };
        }

        console.log('[dingtalk-activate] response:', result.text?.slice(0, 200));
        if (!result.ok) {
          return { error: new Error(`DingTalk activate failed with HTTP ${result.status}`) };
        }

        const data = parseDingtalkJson(result.text);
        if (!data) {
          return { loginRequired: true, loginUrl: buildDingtalkLoginUrl() };
        }
        return { data };
      } catch (err) {
        if (logErrors) console.error('[dingtalk-activate] error:', err);
        return { error: err };
      }
    };

    let result = await tryActivate();
    if (result.data) return assertActivationSuccess(result.data);

    if (result.loginRequired) {
      const loggedIn = await openDingtalkLogin({
        loginUrl: result.loginUrl,
      });
      if (!loggedIn) throw new Error('钉钉登录已取消');
      result = await tryActivate();
      if (!result.data) throw new Error('登录后仍无法激活，请重试');
    }

    if (result.error) throw result.error;
    return assertActivationSuccess(result.data);
  }

  async function fetchMarketList(params = {}) {
    const pageSize = Math.min(Math.max(Number(params.pageSize) || 50, 1), 100);
    const keyword = String(params.keyword || '').trim();
    const search = keyword ? `&search=${encodeURIComponent(keyword)}` : '';
    const url = `${DINGTALK_AIHUB_BASE}/mcp/market/search?page=1&pageSize=${pageSize}${search}`;

    const result = await dingtalkFetch(url);
    if (result.loginRequired || !result.ok) return [];
    try {
      const payload = JSON.parse(result.text);
      return payload?.success ? (payload?.result?.values ?? []) : [];
    } catch {
      return [];
    }
  }

  async function getAuthStatus() {
    return { authenticated: await hasDingtalkAuth() };
  }

  async function logout() {
    await getDingtalkSession().clearStorageData();
    authValidated = false;
    return { authenticated: false };
  }

  /**
   * 使用钉钉 session 下载文件（二进制），自动处理登录。
   * 通过页面内 fetch（真实浏览器上下文）执行下载，保证 Origin/Referer/Cookie/Sec-Fetch-* 一致。
   * 返回 ArrayBuffer。
   */
  async function downloadFile(url) {
    // 确保已登录
    await ensureAuth();

    // 确保 apiWindow 存在（如果不存在则创建一个隐藏窗口加载 aihub 同域轻量页面）
    if (!apiWindow || apiWindow.isDestroyed() || !apiWindow.webContents.getURL().startsWith(DINGTALK_AIHUB_BASE)) {
      console.log('[dingtalk-auth] creating hidden apiWindow for page fetch...');
      const win = new BrowserWindow({
        width: 800,
        height: 600,
        show: false,
        webPreferences: {
          partition: DINGTALK_PARTITION,
          nodeIntegration: false,
          contextIsolation: true,
        },
      });
      // 加载轻量级同域资源（不是 SPA 首页），只要同源就能执行 fetch
      const lightUrl = `${DINGTALK_AIHUB_BASE}/robots.txt`;
      try {
        await Promise.race([
          win.loadURL(lightUrl),
          new Promise((_, reject) => setTimeout(() => reject(new Error('loadURL timeout')), 10000)),
        ]);
      } catch (e) {
        console.log('[dingtalk-auth] loadURL fallback:', e.message);
        // 超时也继续，只要窗口存在就能执行 JS
      }
      apiWindow = win;
      console.log('[dingtalk-auth] apiWindow ready, current URL:', win.webContents.getURL());
    }

    console.log('[dingtalk-auth] downloadFile via page fetch:', url);
    const script = `
      (async () => {
        try {
          const response = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
          if (!response.ok) return { error: 'HTTP ' + response.status, status: response.status };
          const buffer = await response.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          let binary = '';
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          return { ok: true, status: response.status, base64: btoa(binary), size: buffer.byteLength };
        } catch (err) {
          return { error: err.message, status: 0 };
        }
      })()
    `;
    const result = await apiWindow.webContents.executeJavaScript(script);
    console.log('[dingtalk-auth] page fetch result: status=', result?.status, 'size=', result?.size || 0);
    if (result?.error) throw new Error(`下载失败: ${result.error}`);
    const binary = atob(result.base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  return { ensureAuth, activate, fetchMarketList, getAuthStatus, logout, downloadFile };
}
