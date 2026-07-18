// OpenAI / ChatGPT 订阅账号 OAuth (PKCE, browser 模式)。ADR 28。
//
// 该模块只在 main 进程运行:
// - 生成 PKCE verifier/challenge 与 state。
// - 起一个本地 http 回调 server(默认 127.0.0.1:1455),接收 authorization code。
// - 用 shell.openExternal 打开系统浏览器完成授权。
// - code 换 token,并提供 refresh。
//
// token 集合形如 { access, refresh, expires, accountId },由 llm-config-store 整体加密存储。

import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

import { fetchWithConnectionRecovery } from '../provider-transports/recovering-fetch.mjs';

// 在系统浏览器打开授权页。electron 的 shell 仅在 main 运行时可用,
// 故惰性加载,避免该模块在 node 测试环境(无 electron shell 导出)下崩溃。
async function openInBrowser(url) {
  const { shell } = await import('electron');
  await shell.openExternal(url);
}

// 与 opencode 的 ChatGPT 登录一致的公共参数。
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = '/auth/callback';
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPE = 'openid profile email offline_access';

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function createPkce() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// 从 id_token (JWT) 中解析 chatgpt account id。失败返回 undefined,不阻断登录。
function extractAccountId(idToken) {
  if (!idToken || typeof idToken !== 'string') return undefined;
  const parts = idToken.split('.');
  if (parts.length < 2) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    const claim = payload['https://api.openai.com/auth'];
    return claim?.chatgpt_account_id || claim?.organization_id || undefined;
  } catch {
    return undefined;
  }
}

function toTokenSet(json) {
  const expiresInMs = (Number(json.expires_in) || 3600) * 1000;
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + expiresInMs,
    accountId: extractAccountId(json.id_token),
  };
}

// code 换 token。默认走代理感知 fetch(与 Grok OAuth / provider transport 一致),
// 避免 Node 全局 fetch 在有系统代理时直连失败。
async function exchangeCode({ code, verifier, fetchImpl = fetchWithConnectionRecovery }) {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }).toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Token exchange failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return toTokenSet(await res.json());
}

// 用 refresh_token 换新 access_token。
export async function refreshAccessToken(tokens, { fetchImpl = fetchWithConnectionRecovery } = {}) {
  if (!tokens?.refresh) throw new Error('No refresh token available');
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: tokens.refresh,
      scope: SCOPE,
    }).toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Token refresh failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  const next = toTokenSet(await res.json());
  // refresh 响应可能不回传新的 refresh_token / accountId,沿用旧值。
  return {
    access: next.access,
    refresh: next.refresh || tokens.refresh,
    expires: next.expires,
    accountId: next.accountId || tokens.accountId,
  };
}

// 临近过期(默认 60s 缓冲)即刷新。返回 { tokens, refreshed }。
export async function ensureFreshTokens(
  tokens,
  { skewMs = 60_000, fetchImpl = fetchWithConnectionRecovery } = {},
) {
  if (!tokens?.access) throw new Error('Not logged in');
  if (typeof tokens.expires === 'number' && tokens.expires - skewMs > Date.now()) {
    return { tokens, refreshed: false };
  }
  const next = await refreshAccessToken(tokens, { fetchImpl });
  return { tokens: next, refreshed: true };
}

// 回调页贴合 Peer Frost 设计语言(冷雪纸底 / 石墨字 / 冰湖青强调 / Inter)。
// 注意:此 HTML 在系统浏览器里渲染,拿不到 app 的 CSS 变量,故颜色就地写死为
// tokens.css 的真实取值(--paper-* / --graphite-* / --azure-seal)。
const CALLBACK_HTML = (ok) => {
  const accent = ok ? '#3E7A6B' : '#7A3E50';
  const title = ok ? '登录成功' : '登录失败';
  const desc = ok
    ? '凭据已安全写入 Peer Agent，可以关闭此页面并返回应用。'
    : '授权未完成，请关闭此页面并返回 Peer Agent 重试。';
  const glyph = ok
    ? '<path d="M5 13l4.5 4.5L19 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'
    : '<path d="M7 7l10 10M17 7L7 17" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>';
  return (
    `<!doctype html><html lang="zh"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Peer Agent</title>` +
    `<style>` +
    `*{margin:0;padding:0;box-sizing:border-box}` +
    `body{min-height:100vh;display:flex;align-items:center;justify-content:center;` +
    `background:#EDF1F6;` +
    `font-family:"Inter",-apple-system,"PingFang SC","Noto Sans SC","Hiragino Sans GB",system-ui,sans-serif;` +
    `color:#1A1D21;-webkit-font-smoothing:antialiased}` +
    `.card{width:min(420px,calc(100vw - 48px));background:#F7F9FC;` +
    `border:1px solid #DCE0E8;border-radius:16px;padding:40px 36px;text-align:center;` +
    `box-shadow:0 2px 12px rgba(26,29,33,0.06)}` +
    `.mark{width:56px;height:56px;border-radius:50%;display:flex;align-items:center;justify-content:center;` +
    `margin:0 auto 24px;color:${accent};` +
    `background:${ok ? 'rgba(62,122,107,0.10)' : 'rgba(122,62,80,0.10)'}}` +
    `.mark svg{width:30px;height:30px}` +
    `h1{font-size:20px;font-weight:600;letter-spacing:0.01em;margin-bottom:10px}` +
    `p{font-size:14px;line-height:1.6;color:#525660}` +
    `.brand{margin-top:28px;font-size:12px;letter-spacing:0.08em;color:#878B95;text-transform:uppercase}` +
    `</style></head><body>` +
    `<main class="card">` +
    `<div class="mark"><svg viewBox="0 0 24 24" aria-hidden="true">${glyph}</svg></div>` +
    `<h1>${title}</h1>` +
    `<p>${desc}</p>` +
    `<div class="brand">Peer Agent</div>` +
    `</main></body></html>`
  );
};

// 启动一次 browser 模式登录。返回 { promise, cancel }。
// promise resolve 为 token 集合;cancel() 关闭 server 并 reject。
export function startBrowserLogin() {
  const { verifier, challenge } = createPkce();
  const state = base64url(randomBytes(16));

  let server = null;
  let settled = false;
  let resolveFn;
  let rejectFn;

  const promise = new Promise((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });

  function cleanup() {
    if (server) {
      try {
        server.close();
      } catch {}
      server = null;
    }
  }

  function finish(fn, value) {
    if (settled) return;
    settled = true;
    cleanup();
    fn(value);
  }

  server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
    if (reqUrl.pathname !== CALLBACK_PATH) {
      res.writeHead(404);
      res.end();
      return;
    }
    const code = reqUrl.searchParams.get('code');
    const returnedState = reqUrl.searchParams.get('state');
    const error = reqUrl.searchParams.get('error');

    if (error) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(CALLBACK_HTML(false));
      finish(rejectFn, new Error(`OAuth error: ${error}`));
      return;
    }
    if (!code || returnedState !== state) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(CALLBACK_HTML(false));
      finish(rejectFn, new Error('OAuth callback missing code or state mismatch'));
      return;
    }

    try {
      const tokens = await exchangeCode({ code, verifier });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(CALLBACK_HTML(true));
      finish(resolveFn, tokens);
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(CALLBACK_HTML(false));
      finish(rejectFn, err);
    }
  });

  function onListening() {
    const authorizeUrl = new URL(AUTHORIZE_URL);
    authorizeUrl.searchParams.set('client_id', CLIENT_ID);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI);
    authorizeUrl.searchParams.set('scope', SCOPE);
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('id_token_add_organizations', 'true');
    openInBrowser(authorizeUrl.toString()).catch((err) => finish(rejectFn, err));
  }

  // 端口 1455 是注册死的 OAuth 回调端口,不能换。占用多半来自上一次
  // 登录残留的本地回调 server(close 是异步释放,紧接着 listen 可能仍抢不到)。
  // 故命中 EADDRINUSE 时先关掉当前句柄、短暂等待后重试一次;仍失败再抛
  // 结构化错误码 oauth_port_in_use:<port>,由前端翻译成可操作的中文提示,
  // 不再把裸 node 错误串透传到界面。
  let portRetried = false;
  function onServerError(err) {
    if (err?.code === 'EADDRINUSE' && !portRetried) {
      portRetried = true;
      try { server.close(); } catch {}
      setTimeout(() => {
        if (settled) return;
        try {
          server.listen(CALLBACK_PORT, '127.0.0.1', onListening);
        } catch (retryErr) {
          finish(rejectFn, retryErr);
        }
      }, 350);
      return;
    }
    if (err?.code === 'EADDRINUSE') {
      finish(rejectFn, new Error(`oauth_port_in_use:${CALLBACK_PORT}`));
      return;
    }
    finish(rejectFn, err);
  }

  server.on('error', onServerError);

  server.listen(CALLBACK_PORT, '127.0.0.1', onListening);

  function cancel() {
    finish(rejectFn, new Error('OAuth login cancelled'));
  }

  return { promise, cancel };
}
