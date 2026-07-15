// Grok Build 订阅账号 OAuth（RFC 8628 device authorization grant）。
//
// 使用 Grok CLI 的公共 OIDC client 与 grok-cli:access scope，不需要用户创建
// xAI 开发者应用。token 集合由 llm-config-store 整体加密保存。

export const GROK_OIDC_ISSUER = 'https://auth.x.ai';
export const GROK_CLI_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
export const GROK_LOGIN_SCOPE = 'openid profile email offline_access grok-cli:access';

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const DEFAULT_INTERVAL_SECONDS = 5;
const DEFAULT_EXPIRES_SECONDS = 15 * 60;

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function createOAuthError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function readJson(response, label) {
  const body = await response.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw createOAuthError('grok_oauth_invalid_response', `${label} returned invalid JSON`);
  }
  return body;
}

async function postForm(fetchImpl, url, params, signal) {
  return fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    signal,
  });
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createOAuthError('grok_oauth_cancelled', 'Grok login cancelled'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(createOAuthError('grok_oauth_cancelled', 'Grok login cancelled'));
    }, { once: true });
  });
}

async function requestDeviceCode(fetchImpl, { issuer, clientId, scope, signal }) {
  const response = await postForm(fetchImpl, `${issuer}/oauth2/device/code`, {
    client_id: clientId,
    scope,
  }, signal);
  const body = await readJson(response, 'Grok device authorization');
  if (!response.ok) {
    throw createOAuthError(nonEmpty(body.error) || 'grok_device_code_failed', nonEmpty(body.error_description) || `Grok device authorization failed (${response.status})`);
  }
  const deviceCode = nonEmpty(body.device_code);
  const userCode = nonEmpty(body.user_code);
  const verificationUrl = nonEmpty(body.verification_uri_complete) || nonEmpty(body.verification_uri);
  if (!deviceCode || !userCode || !verificationUrl) {
    throw createOAuthError('grok_oauth_invalid_response', 'Grok device authorization response is incomplete');
  }
  const intervalSeconds = Math.max(1, Number(body.interval) || DEFAULT_INTERVAL_SECONDS);
  const expiresSeconds = Math.max(1, Number(body.expires_in) || DEFAULT_EXPIRES_SECONDS);
  return {
    deviceCode,
    userCode,
    verificationUrl,
    intervalSeconds,
    expiresAt: Date.now() + expiresSeconds * 1000,
  };
}

async function pollForTokens(fetchImpl, { issuer, clientId, device, signal }) {
  let intervalSeconds = device.intervalSeconds;
  while (Date.now() < device.expiresAt) {
    await delay(intervalSeconds * 1000, signal);
    const response = await postForm(fetchImpl, `${issuer}/oauth2/token`, {
      grant_type: DEVICE_GRANT,
      device_code: device.deviceCode,
      client_id: clientId,
    }, signal);
    const body = await readJson(response, 'Grok device token');
    if (response.ok) return normalizeTokenResponse(body, { issuer, clientId });

    const code = nonEmpty(body.error) || `http_${response.status}`;
    if (code === 'authorization_pending') continue;
    if (code === 'slow_down') {
      intervalSeconds += 5;
      continue;
    }
    if (code === 'expired_token') {
      throw createOAuthError('grok_device_code_expired', 'Grok login code expired');
    }
    if (code === 'access_denied') {
      throw createOAuthError('grok_oauth_access_denied', 'Grok login was denied');
    }
    throw createOAuthError(code, nonEmpty(body.error_description) || `Grok login failed (${response.status})`);
  }
  throw createOAuthError('grok_device_code_expired', 'Grok login code expired');
}

function normalizeTokenResponse(body, { issuer = GROK_OIDC_ISSUER, clientId = GROK_CLI_CLIENT_ID, previousRefresh = null } = {}) {
  const access = nonEmpty(body.access_token);
  if (!access) throw createOAuthError('grok_oauth_invalid_response', 'Grok token response is missing access_token');
  const refresh = nonEmpty(body.refresh_token) || previousRefresh;
  const expiresIn = Math.max(1, Number(body.expires_in) || 3600);
  return {
    access,
    refresh,
    expires: Date.now() + expiresIn * 1000,
    issuer,
    clientId,
  };
}

async function fetchUserInfo(fetchImpl, tokens, signal) {
  const response = await fetchImpl(`${tokens.issuer || GROK_OIDC_ISSUER}/oauth2/userinfo`, {
    headers: { authorization: `Bearer ${tokens.access}` },
    signal,
  });
  if (!response.ok) return null;
  const body = await response.json().catch(() => null);
  return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
}

export function startGrokOAuthLogin({
  openExternal,
  onPending,
  fetchImpl = fetch,
  issuer = GROK_OIDC_ISSUER,
  clientId = GROK_CLI_CLIENT_ID,
  scope = GROK_LOGIN_SCOPE,
} = {}) {
  const controller = new AbortController();
  const promise = (async () => {
    const device = await requestDeviceCode(fetchImpl, {
      issuer,
      clientId,
      scope,
      signal: controller.signal,
    });
    const pending = {
      verificationUrl: device.verificationUrl,
      userCode: device.userCode,
      expiresAt: new Date(device.expiresAt).toISOString(),
    };
    onPending?.(pending);
    if (typeof openExternal === 'function') await openExternal(device.verificationUrl);
    const tokens = await pollForTokens(fetchImpl, {
      issuer,
      clientId,
      device,
      signal: controller.signal,
    });
    const userInfo = await fetchUserInfo(fetchImpl, tokens, controller.signal);
    return {
      ...tokens,
      email: nonEmpty(userInfo?.email),
      userId: nonEmpty(userInfo?.sub),
    };
  })();
  return {
    promise,
    cancel() {
      controller.abort();
    },
  };
}

export async function refreshGrokTokens(tokens, { fetchImpl = fetch } = {}) {
  if (!tokens?.refresh) throw createOAuthError('grok_oauth_refresh_missing', 'Grok refresh token is missing');
  const issuer = nonEmpty(tokens.issuer) || GROK_OIDC_ISSUER;
  const clientId = nonEmpty(tokens.clientId) || GROK_CLI_CLIENT_ID;
  const response = await postForm(fetchImpl, `${issuer}/oauth2/token`, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh,
    client_id: clientId,
  });
  const body = await readJson(response, 'Grok token refresh');
  if (!response.ok) {
    throw createOAuthError(nonEmpty(body.error) || 'grok_oauth_refresh_failed', nonEmpty(body.error_description) || `Grok token refresh failed (${response.status})`);
  }
  return {
    ...tokens,
    ...normalizeTokenResponse(body, { issuer, clientId, previousRefresh: tokens.refresh }),
  };
}

export async function ensureFreshGrokTokens(tokens, { skewMs = 60_000, fetchImpl = fetch } = {}) {
  if (!tokens?.access) throw createOAuthError('grok_oauth_not_logged_in', 'Grok login required');
  if (typeof tokens.expires === 'number' && tokens.expires - skewMs > Date.now()) {
    return { tokens, refreshed: false };
  }
  const refreshedTokens = await refreshGrokTokens(tokens, { fetchImpl });
  return { tokens: refreshedTokens, refreshed: true };
}
