// Google / Gemini OAuth (PKCE, browser mode).
//
// The application owns the installed-app OAuth identity. Callers provide no
// client configuration; tokens remain encrypted by llm-config-store.

import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

import { fetchWithConnectionRecovery } from '../provider-transports/recovering-fetch.mjs';

async function openInBrowser(url) {
  const { shell } = await import('electron');
  await shell.openExternal(url);
}

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// Public installed-app credentials from google-gemini/gemini-cli.
const DEFAULT_CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
// Keep in sync with google-gemini/gemini-cli packages/core/src/code_assist/oauth2.ts
const DEFAULT_CLIENT_SECRET = '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';
const CALLBACK_PORT = 1456;
const CALLBACK_PATH = '/auth/google/callback';
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPE = 'openid email profile https://www.googleapis.com/auth/cloud-platform';

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function createPkce() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function extractEmail(idToken) {
  if (!idToken || typeof idToken !== 'string') return undefined;
  const parts = idToken.split('.');
  if (parts.length < 2) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    return payload.email || payload.sub || undefined;
  } catch {
    return undefined;
  }
}

function toTokenSet(json) {
  const expiresInMs = (Number(json.expires_in) || 3600) * 1000;
  return {
    provider: 'google',
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + expiresInMs,
    accountId: extractEmail(json.id_token),
  };
}

async function exchangeCode({ code, verifier, fetchImpl = fetchWithConnectionRecovery }) {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: DEFAULT_CLIENT_ID,
      client_secret: DEFAULT_CLIENT_SECRET,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }).toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Google token exchange failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return toTokenSet(await res.json());
}

export async function refreshGoogleAccessToken(tokens, { fetchImpl = fetchWithConnectionRecovery } = {}) {
  if (!tokens?.refresh) throw new Error('No Google refresh token available');
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: DEFAULT_CLIENT_ID,
      client_secret: DEFAULT_CLIENT_SECRET,
      refresh_token: tokens.refresh,
    }).toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Google token refresh failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  const next = toTokenSet(await res.json());
  return {
    provider: 'google',
    access: next.access,
    refresh: next.refresh || tokens.refresh,
    expires: next.expires,
    accountId: next.accountId || tokens.accountId,
  };
}

export async function ensureFreshGoogleTokens(
  tokens,
  { skewMs = 60_000, fetchImpl = fetchWithConnectionRecovery } = {},
) {
  if (!tokens?.access) throw new Error('Not logged in');
  if (typeof tokens.expires === 'number' && tokens.expires - skewMs > Date.now()) {
    return { tokens, refreshed: false };
  }
  const next = await refreshGoogleAccessToken(tokens, { fetchImpl });
  return { tokens: next, refreshed: true };
}

const CALLBACK_HTML = (ok) => {
  const accent = ok ? '#3E7A6B' : '#7A3E50';
  const title = ok ? '登录成功' : '登录失败';
  const desc = ok
    ? 'Google 凭据已安全写入 Peer Agent，可以关闭此页面并返回应用。'
    : 'Google 授权未完成，请关闭此页面并返回 Peer Agent 重试。';
  const glyph = ok
    ? '<path d="M5 13l4.5 4.5L19 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'
    : '<path d="M7 7l10 10M17 7L7 17" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>';
  return (
    `<!doctype html><html lang="zh"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Peer Agent</title>` +
    `<style>*{margin:0;padding:0;box-sizing:border-box}` +
    `body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#EDF1F6;` +
    `font-family:"Inter",-apple-system,"PingFang SC","Noto Sans SC",system-ui,sans-serif;color:#1A1D21}` +
    `.card{width:min(420px,calc(100vw - 48px));background:#F7F9FC;border:1px solid #DCE0E8;` +
    `border-radius:16px;padding:40px 36px;text-align:center;box-shadow:0 2px 12px rgba(26,29,33,0.06)}` +
    `.mark{width:56px;height:56px;border-radius:50%;display:flex;align-items:center;justify-content:center;` +
    `margin:0 auto 24px;color:${accent};background:${ok ? 'rgba(62,122,107,0.10)' : 'rgba(122,62,80,0.10)'}}` +
    `.mark svg{width:30px;height:30px}h1{font-size:20px;font-weight:600;margin-bottom:10px}` +
    `p{font-size:14px;line-height:1.6;color:#525660}.brand{margin-top:28px;font-size:12px;letter-spacing:.08em;color:#878B95;text-transform:uppercase}` +
    `</style></head><body><main class="card">` +
    `<div class="mark"><svg viewBox="0 0 24 24" aria-hidden="true">${glyph}</svg></div>` +
    `<h1>${title}</h1><p>${desc}</p><div class="brand">Peer Agent</div>` +
    `</main></body></html>`
  );
};

export function startGoogleBrowserLogin() {
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
      try { server.close(); } catch {}
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
      finish(rejectFn, new Error(`Google OAuth error: ${error}`));
      return;
    }
    if (!code || returnedState !== state) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(CALLBACK_HTML(false));
      finish(rejectFn, new Error('Google OAuth callback missing code or state mismatch'));
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
    authorizeUrl.searchParams.set('client_id', DEFAULT_CLIENT_ID);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI);
    authorizeUrl.searchParams.set('scope', SCOPE);
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('access_type', 'offline');
    authorizeUrl.searchParams.set('prompt', 'consent');
    openInBrowser(authorizeUrl.toString()).catch((err) => finish(rejectFn, err));
  }

  // Port 1456 is the registered OAuth callback port and cannot be swapped.
  // A conflict usually comes from a leftover callback server of a previous
  // login (close() releases the port asynchronously, so an immediate listen
  // may still fail). On EADDRINUSE, close the current handle, wait briefly,
  // and retry once; if it still fails, reject with a structured error code
  // oauth_port_in_use:<port> that the renderer turns into an actionable
  // message instead of surfacing the raw node error string.
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
    finish(rejectFn, new Error('Google OAuth login cancelled'));
  }

  return { promise, cancel };
}
