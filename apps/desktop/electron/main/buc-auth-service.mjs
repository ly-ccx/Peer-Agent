import { safeStorage, shell } from 'electron';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';

const DAILY_BASE_URL = 'https://login-test.alibaba-inc.com';
const PROD_BASE_URL = 'https://login.alibaba-inc.com';
const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:16888/oauth/callback';
const DEFAULT_LOGOUT_BACK_URL = 'http://127.0.0.1:16888/logout/callback';
const DEFAULT_SCOPE = 'profile openid';
const execFileAsync = promisify(execFile);

function base64Url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function sha256Base64Url(input) {
  return base64Url(createHash('sha256').update(input).digest());
}

function formBody(params) {
  return new URLSearchParams(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  ).toString();
}

function htmlPage(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
}

async function postFormJson(url, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    },
    body: formBody(params),
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.error || json.errorCode) {
    const message = json.error_description ?? json.errorMsg ?? json.error ?? `HTTP ${response.status}`;
    throw new Error(message);
  }

  return json;
}

async function openExternalUrl(url) {
  const browserApp = process.env.ZEUS_ATLAS_BUC_BROWSER_APP;

  if (browserApp && process.platform === 'darwin') {
    await execFileAsync('open', ['-a', browserApp, url]);
    return;
  }

  await shell.openExternal(url);
}

function normalizeUserInfo(raw) {
  const joinedName = [raw.firstName, raw.lastName].filter(Boolean).join(' ') || undefined;

  return {
    account: raw.account,
    accountId: raw.account_id ? String(raw.account_id) : raw.accountId ? String(raw.accountId) : undefined,
    empId: raw.emp_id ?? raw.empId,
    name: raw.name ?? joinedName,
    nickname: raw.nickname ?? raw.nickNameCn,
    userType: raw.user_type ?? raw.userType,
    avatar: raw.picture ?? raw.avatar,
    locale: raw.locale ?? raw.siteLanguage,
    realmId: raw.realm_id ? String(raw.realm_id) : raw.realmId ? String(raw.realmId) : undefined,
    realmName: raw.realm_name ?? raw.realmName,
    openid: raw.openid,
  };
}

function resolveConfig() {
  const environment = process.env.ZEUS_ATLAS_BUC_ENV === 'prod' ? 'prod' : 'daily';
  const baseUrl = process.env.ZEUS_ATLAS_BUC_BASE_URL ?? (environment === 'prod' ? PROD_BASE_URL : DAILY_BASE_URL);
  const clientId = process.env.ZEUS_ATLAS_BUC_CLIENT_ID;
  const redirectUri = process.env.ZEUS_ATLAS_BUC_REDIRECT_URI ?? DEFAULT_REDIRECT_URI;
  const logoutBackUrl = process.env.ZEUS_ATLAS_BUC_LOGOUT_BACK_URL ?? DEFAULT_LOGOUT_BACK_URL;
  const scope = process.env.ZEUS_ATLAS_BUC_SCOPE ?? DEFAULT_SCOPE;

  return {
    provider: 'buc',
    environment,
    baseUrl,
    clientId,
    redirectUri,
    logoutBackUrl,
    scope,
    configured: Boolean(clientId),
  };
}

function tokenStorePath(userDataPath) {
  return path.join(userDataPath, 'auth', 'buc-token.bin');
}

function createTokenStore({ userDataPath }) {
  let memoryToken = null;

  function read() {
    if (memoryToken) {
      return memoryToken;
    }

    const filePath = tokenStorePath(userDataPath);
    if (!existsSync(filePath) || !safeStorage.isEncryptionAvailable()) {
      return null;
    }

    try {
      const encrypted = readFileSync(filePath);
      memoryToken = JSON.parse(safeStorage.decryptString(encrypted));
      return memoryToken;
    } catch {
      return null;
    }
  }

  function write(record) {
    memoryToken = record;
    if (!safeStorage.isEncryptionAvailable()) {
      return;
    }

    const filePath = tokenStorePath(userDataPath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, safeStorage.encryptString(JSON.stringify(record)));
  }

  function clear() {
    memoryToken = null;
    rmSync(tokenStorePath(userDataPath), { force: true });
  }

  return { read, write, clear };
}

function startCallbackServer({ redirectUri, expectedState, timeoutMs = 60000 }) {
  const redirectUrl = new URL(redirectUri);

  let abort = () => {};
  const promise = new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const currentUrl = new URL(request.url ?? '/', redirectUri);
      if (currentUrl.pathname !== redirectUrl.pathname) {
        response.writeHead(404);
        response.end();
        return;
      }

      const error = currentUrl.searchParams.get('error');
      const code = currentUrl.searchParams.get('code');
      const state = currentUrl.searchParams.get('state');

      if (error) {
        response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(htmlPage('Zeus Atlas 登录失败', '<h2>登录失败，请回到 Zeus Atlas 重试。</h2>'));
        cleanup();
        reject(new Error(error));
        return;
      }

      if (state !== expectedState || !code) {
        response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(htmlPage('Zeus Atlas 登录失败', '<h2>登录状态不匹配，请回到 Zeus Atlas 重试。</h2>'));
        cleanup();
        reject(new Error('OAuth state mismatch.'));
        return;
      }

      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(htmlPage('Zeus Atlas 登录成功', '<h2>登录成功，可以关闭这个页面。</h2>'));
      cleanup();
      resolve({ code });
    });

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('BUC login timed out.'));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      server.close();
    }

    // 供 cancelLogin 主动中断：关 server + reject，立即解除 login() 的 await 阻塞，
    // 同时释放 16888 端口，让用户去申请权限后回来能立刻重试。
    abort = () => {
      cleanup();
      reject(new Error('BUC login cancelled.'));
    };

    server.on('error', (error) => {
      cleanup();
      reject(error);
    });

    server.listen(Number(redirectUrl.port), redirectUrl.hostname);
  });

  return { promise, abort };
}

function startReturnPageServer(backUrl) {
  const returnUrl = new URL(backUrl);
  const server = http.createServer((request, response) => {
    const currentUrl = new URL(request.url ?? '/', backUrl);
    if (currentUrl.pathname !== returnUrl.pathname) {
      response.writeHead(404);
      response.end();
      return;
    }

    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(htmlPage('Zeus Atlas 已退出登录', '<h2>已退出登录，可以关闭这个页面。</h2>'));
    server.close();
  });

  server.on('error', () => undefined);
  server.listen(Number(returnUrl.port), returnUrl.hostname);
  setTimeout(() => server.close(), 120000);
}

export function createBucAuthService({ userDataPath }) {
  const tokenStore = createTokenStore({ userDataPath });
  let loginPromise = null;
  let activeLoginAbort = null;

  async function fetchUserInfo(accessToken) {
    const config = resolveConfig();
    const raw = await postFormJson(`${config.baseUrl}/rpc/oauth2/user_info.json`, { access_token: accessToken });
    return normalizeUserInfo(raw);
  }

  async function refresh(record) {
    const config = resolveConfig();
    if (!record?.refreshToken) {
      return null;
    }

    const token = await postFormJson(`${config.baseUrl}/rpc/oauth2/refresh_token.json`, {
      grant_type: 'refresh_token',
      refresh_token: record.refreshToken,
    });

    const nextRecord = {
      ...record,
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? record.refreshToken,
      idToken: token.id_token,
      tokenType: token.token_type ?? 'Bearer',
      expiresAt: Date.now() + Number(token.expires_in ?? 0) * 1000,
      updatedAt: Date.now(),
    };
    tokenStore.write(nextRecord);
    return nextRecord;
  }

  async function getValidRecord() {
    const record = tokenStore.read();
    if (!record) {
      return null;
    }

    if (record.expiresAt && record.expiresAt - Date.now() > 60000) {
      return record;
    }

    try {
      return await refresh(record);
    } catch {
      tokenStore.clear();
      return null;
    }
  }

  async function getAuthState() {
    const config = resolveConfig();
    if (!config.configured) {
      return {
        status: 'not_configured',
        provider: 'buc',
        config,
        updatedAt: new Date().toISOString(),
      };
    }

    const record = await getValidRecord();
    if (!record) {
      return {
        status: 'signed_out',
        provider: 'buc',
        config,
        updatedAt: new Date().toISOString(),
      };
    }

    return {
      status: 'authenticated',
      provider: 'buc',
      config,
      user: record.user,
      tokenExpiresAt: record.expiresAt ? new Date(record.expiresAt).toISOString() : undefined,
      updatedAt: new Date().toISOString(),
    };
  }

  async function getAccessToken() {
    const config = resolveConfig();
    if (!config.configured) {
      throw new Error('BUC client_id is not configured.');
    }

    const record = await getValidRecord();
    if (!record?.accessToken) {
      throw new Error('BUC sign-in is required.');
    }

    return record.accessToken;
  }

  async function login() {
    const config = resolveConfig();
    if (!config.configured) {
      throw new Error('BUC client_id is not configured.');
    }

    if (loginPromise) {
      return loginPromise;
    }

    loginPromise = (async () => {
      const state = randomUUID();
      const nonce = randomUUID();
      const codeVerifier = base64Url(randomBytes(48));
      const codeChallenge = sha256Base64Url(codeVerifier);

      const callback = startCallbackServer({
        redirectUri: config.redirectUri,
        expectedState: state,
      });
      activeLoginAbort = callback.abort;

      const authUrl = new URL('/oauth2/auth.htm', config.baseUrl);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', config.clientId);
      authUrl.searchParams.set('redirect_uri', config.redirectUri);
      authUrl.searchParams.set('scope', config.scope);
      authUrl.searchParams.set('state', state);
      authUrl.searchParams.set('nonce', nonce);
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');

      await openExternalUrl(authUrl.toString());
      const { code } = await callback.promise;

      const token = await postFormJson(`${config.baseUrl}/rpc/oauth2/access_token.json`, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.redirectUri,
        client_id: config.clientId,
        code_verifier: codeVerifier,
      });
      const user = await fetchUserInfo(token.access_token);

      tokenStore.write({
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        idToken: token.id_token,
        tokenType: token.token_type ?? 'Bearer',
        expiresAt: Date.now() + Number(token.expires_in ?? 0) * 1000,
        user,
        updatedAt: Date.now(),
      });

      return getAuthState();
    })();

    try {
      return await loginPromise;
    } finally {
      loginPromise = null;
      activeLoginAbort = null;
    }
  }

  function cancelLogin() {
    // 用户主动取消（典型：跳去另一平台申请权限后回到客户端）：中断挂起的 callback
    // 等待、关 server 释放 16888 端口、清登录缓存，让界面立刻可重试。
    if (activeLoginAbort) {
      activeLoginAbort();
      activeLoginAbort = null;
    }
    loginPromise = null;
    return getAuthState();
  }

  async function logout() {
    const config = resolveConfig();
    const record = tokenStore.read();

    if (record?.accessToken) {
      await postFormJson(`${config.baseUrl}/rpc/oauth2/disable_token.json`, {
        access_token: record.accessToken,
      }).catch(() => undefined);
    }

    tokenStore.clear();

    if (config.configured) {
      startReturnPageServer(config.logoutBackUrl);
      const logoutUrl = new URL('/ssoLogout.htm', config.baseUrl);
      logoutUrl.searchParams.set('APP_NAME', config.clientId);
      logoutUrl.searchParams.set('BACK_URL', config.logoutBackUrl);
      await openExternalUrl(logoutUrl.toString());
    }

    return getAuthState();
  }

  return {
    getAccessToken,
    getAuthState,
    login,
    cancelLogin,
    logout,
  };
}
