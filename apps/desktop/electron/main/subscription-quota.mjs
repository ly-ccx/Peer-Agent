// 订阅额度查询（GPT / Gemini / Grok）。
// 数据源对齐 CodexBar：
// - GPT: ChatGPT backend wham/usage
// - Gemini: cloudcode-pa retrieveUserQuota
// - Grok: grok.com GrokBuildBilling GetGrokCreditsConfig
// 只在 main 进程运行；复用已有 OAuth 会话（resolveProviderCredential），不引入第三方依赖。

import { resolveProviderCredential, getProviderCredentialErrorCode } from './provider-credential-resolver.mjs';

const QUOTA_TTL_MS = 60_000;
/** 新鲜缓存：TTL 内直接返回，避免重复打供应商接口。 */
const quotaCache = new Map(); // cacheKey -> { expiresAt, result }
/**
 * 上次成功额度：进程生命周期内保留，TTL 过期后仍可先回给 UI，
 * 便于设置页进入时立刻展示「上次额度」，再后台 force 静默刷新。
 */
const lastSuccessByKey = new Map(); // cacheKey -> result

const OAUTH_METHODS = new Set(['oauth_chatgpt', 'oauth_google', 'oauth_grok']);

function nowIso() {
  return new Date().toISOString();
}

function clampPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function remainingFromUsed(usedPercent) {
  const used = clampPercent(usedPercent);
  if (used == null) return null;
  return clampPercent(100 - used);
}

function isoFromUnixSeconds(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  // CodexBar 的 reset_at 可能是秒或毫秒
  const ms = seconds > 1e12 ? seconds : seconds * 1000;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function isoFromMaybeDate(value) {
  if (!value) return undefined;
  if (typeof value === 'number') return isoFromUnixSeconds(value);
  if (typeof value === 'string') {
    const asNum = Number(value);
    if (Number.isFinite(asNum) && asNum > 0) return isoFromUnixSeconds(asNum);
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return undefined;
}

function windowLabel(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  if (seconds <= 60 * 60 * 6) return 'session';
  if (seconds <= 60 * 60 * 48) return 'daily';
  if (seconds <= 60 * 60 * 24 * 10) return 'weekly';
  return 'monthly';
}

function failure(code, message) {
  return {
    success: false,
    status: code,
    error: message || code,
    fetchedAt: nowIso(),
  };
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── GPT / ChatGPT subscription (wham/usage) ─────────────────────────────

export async function fetchChatGptUsage({ accessToken, accountId, fetchImpl = fetch } = {}) {
  if (!accessToken) throw new Error('oauth_not_logged_in');

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
    'User-Agent': 'PeerAgent/1.0',
  };
  if (accountId) {
    headers['ChatGPT-Account-ID'] = accountId;
    headers['chatgpt-account-id'] = accountId;
  }

  const response = await fetchImpl('https://chatgpt.com/backend-api/wham/usage', {
    method: 'GET',
    headers,
  });

  if (response.status === 401 || response.status === 403) {
    throw Object.assign(new Error('oauth_session_expired'), { code: 'oauth_session_expired' });
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw Object.assign(new Error(`usage_http_${response.status}:${body.slice(0, 160)}`), {
      code: 'quota_fetch_failed',
    });
  }

  const payload = await readJsonResponse(response);
  const rateLimit = payload?.rate_limit || payload?.rateLimit || null;
  const primary = rateLimit?.primary_window || rateLimit?.primaryWindow || null;
  const secondary = rateLimit?.secondary_window || rateLimit?.secondaryWindow || null;

  const windows = [];
  for (const [source, window] of [['primary', primary], ['secondary', secondary]]) {
    if (!window || typeof window !== 'object') continue;
    const used = clampPercent(Number(window.used_percent ?? window.usedPercent));
    if (used == null) continue;
    const remaining = remainingFromUsed(used);
    const resetsAt = isoFromMaybeDate(window.reset_at ?? window.resetAt);
    const limitSeconds = Number(window.limit_window_seconds ?? window.limitWindowSeconds);
    windows.push({
      id: source,
      label: windowLabel(limitSeconds) || source,
      remainingPercent: remaining ?? undefined,
      usedPercent: used,
      resetsAt,
    });
  }

  if (windows.length === 0) {
    throw Object.assign(new Error('usage_parse_failed'), { code: 'quota_parse_failed' });
  }

  const primaryWindow = windows[0];
  return {
    success: true,
    status: 'ok',
    provider: 'chatgpt',
    planLabel: typeof payload?.plan_type === 'string'
      ? payload.plan_type
      : (typeof payload?.planType === 'string' ? payload.planType : undefined),
    remainingPercent: primaryWindow.remainingPercent,
    usedPercent: primaryWindow.usedPercent,
    resetsAt: primaryWindow.resetsAt,
    windows,
    fetchedAt: nowIso(),
  };
}

// ── Gemini Code Assist (retrieveUserQuota) ──────────────────────────────

export async function fetchGeminiQuota({ accessToken, projectId, fetchImpl = fetch } = {}) {
  if (!accessToken) throw new Error('oauth_not_logged_in');

  let resolvedProjectId = projectId || null;

  // CodexBar：先 loadCodeAssist 拿 cloudaicompanionProject，再 retrieveUserQuota。
  try {
    const statusRes = await fetchImpl('https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'PeerAgent/1.0',
      },
      body: JSON.stringify({}),
    });
    if (statusRes.ok) {
      const statusJson = await readJsonResponse(statusRes);
      const fromStatus = statusJson?.cloudaicompanionProject
        || statusJson?.cloudAiCompanionProject
        || statusJson?.projectId
        || null;
      if (typeof fromStatus === 'string' && fromStatus) resolvedProjectId = fromStatus;
    }
  } catch {
    // loadCodeAssist 失败时仍尝试 retrieveUserQuota（空 body 在部分账号可用）
  }

  const body = resolvedProjectId
    ? { project: resolvedProjectId }
    : {};

  const response = await fetchImpl('https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'PeerAgent/1.0',
    },
    body: JSON.stringify(body),
  });

  if (response.status === 401 || response.status === 403) {
    throw Object.assign(new Error('oauth_session_expired'), { code: 'oauth_session_expired' });
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw Object.assign(new Error(`quota_http_${response.status}:${text.slice(0, 160)}`), {
      code: 'quota_fetch_failed',
    });
  }

  const payload = await readJsonResponse(response);
  const buckets = Array.isArray(payload?.buckets) ? payload.buckets : [];
  if (buckets.length === 0) {
    throw Object.assign(new Error('quota_parse_failed'), { code: 'quota_parse_failed' });
  }

  // 按模型取最低 remainingFraction（输入额度通常更紧）。
  const byModel = new Map();
  for (const bucket of buckets) {
    const modelId = bucket?.modelId || bucket?.model_id || 'default';
    const remainingFraction = Number(bucket?.remainingFraction ?? bucket?.remaining_fraction);
    if (!Number.isFinite(remainingFraction)) continue;
    const remainingPercent = clampPercent(remainingFraction <= 1.5 ? remainingFraction * 100 : remainingFraction);
    if (remainingPercent == null) continue;
    const resetsAt = isoFromMaybeDate(bucket?.resetTime || bucket?.reset_time);
    const prev = byModel.get(modelId);
    if (!prev || remainingPercent < prev.remainingPercent) {
      byModel.set(modelId, {
        id: modelId,
        label: modelId,
        remainingPercent,
        usedPercent: clampPercent(100 - remainingPercent) ?? undefined,
        resetsAt,
      });
    }
  }

  const windows = [...byModel.values()].sort((a, b) => a.remainingPercent - b.remainingPercent);
  if (windows.length === 0) {
    throw Object.assign(new Error('quota_parse_failed'), { code: 'quota_parse_failed' });
  }

  const worst = windows[0];
  return {
    success: true,
    status: 'ok',
    provider: 'gemini',
    remainingPercent: worst.remainingPercent,
    usedPercent: worst.usedPercent,
    resetsAt: worst.resetsAt,
    windows,
    fetchedAt: nowIso(),
    projectId: resolvedProjectId || undefined,
  };
}

// ── Grok web billing (GetGrokCreditsConfig, grpc-web) ───────────────────

function readVarint(bytes, indexRef) {
  let result = 0n;
  let shift = 0n;
  while (indexRef.i < bytes.length) {
    const byte = BigInt(bytes[indexRef.i]);
    indexRef.i += 1;
    result |= (byte & 0x7fn) << shift;
    if ((byte & 0x80n) === 0n) return result;
    shift += 7n;
    if (shift > 63n) return null;
  }
  return null;
}

function decodeFixed32Float(bytes, offset) {
  if (offset + 4 > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
  return view.getFloat32(0, true);
}

function decodeFixed64Double(bytes, offset) {
  if (offset + 8 > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
  return view.getFloat64(0, true);
}

function collectProtoNumbers(bytes, depth = 0, out = { floats: [], varints: [], timestamps: [] }) {
  if (depth > 6) return out;
  const indexRef = { i: 0 };
  while (indexRef.i < bytes.length) {
    const key = readVarint(bytes, indexRef);
    if (key == null) break;
    const wireType = Number(key & 0x7n);
    const fieldNumber = Number(key >> 3n);
    if (wireType === 0) {
      const value = readVarint(bytes, indexRef);
      if (value == null) break;
      const asNumber = Number(value);
      out.varints.push(asNumber);
      // 可能是 unix 秒
      if (asNumber > 1_700_000_000 && asNumber < 2_200_000_000) out.timestamps.push(asNumber);
    } else if (wireType === 1) {
      const value = decodeFixed64Double(bytes, indexRef.i);
      indexRef.i += 8;
      if (value != null) {
        out.floats.push(value);
        if (value > 1_700_000_000 && value < 2_200_000_000) out.timestamps.push(value);
      }
    } else if (wireType === 2) {
      const length = readVarint(bytes, indexRef);
      if (length == null) break;
      const len = Number(length);
      if (len < 0 || indexRef.i + len > bytes.length) break;
      const nested = bytes.subarray(indexRef.i, indexRef.i + len);
      indexRef.i += len;
      collectProtoNumbers(nested, depth + 1, out);
    } else if (wireType === 5) {
      const value = decodeFixed32Float(bytes, indexRef.i);
      indexRef.i += 4;
      if (value != null) out.floats.push(value);
    } else {
      break;
    }
    void fieldNumber;
  }
  return out;
}

function parseGrokGrpcWeb(body) {
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
  const frames = [];
  let i = 0;
  while (i + 5 <= bytes.length) {
    const flags = bytes[i];
    const length = (bytes[i + 1] << 24) | (bytes[i + 2] << 16) | (bytes[i + 3] << 8) | bytes[i + 4];
    i += 5;
    if (length < 0 || i + length > bytes.length) break;
    if ((flags & 0x80) === 0) frames.push(bytes.subarray(i, i + length));
    i += length;
  }

  const payloads = frames.length > 0 ? frames : [bytes];
  const floats = [];
  const timestamps = [];
  for (const payload of payloads) {
    const scan = collectProtoNumbers(payload);
    floats.push(...scan.floats);
    timestamps.push(...scan.timestamps);
  }

  // CodexBar：取 0..100 的 fixed32/float 作为 usedPercent；若没有用量字段但有周期，则视为 0。
  const percentCandidates = floats
    .map((value) => {
      if (!Number.isFinite(value)) return null;
      if (value >= 0 && value <= 100) return value;
      if (value >= 0 && value <= 1.0001) return value * 100;
      return null;
    })
    .filter((value) => value != null);

  let usedPercent = percentCandidates.length > 0
    ? clampPercent(Math.max(...percentCandidates))
    : null;

  if (usedPercent == null && timestamps.length > 0) {
    usedPercent = 0;
  }
  if (usedPercent == null) {
    throw Object.assign(new Error('quota_parse_failed'), { code: 'quota_parse_failed' });
  }

  const futureTs = timestamps
    .map((value) => (value > 1e12 ? value / 1000 : value))
    .filter((value) => value * 1000 > Date.now())
    .sort((a, b) => a - b);
  const resetsAt = futureTs.length > 0 ? isoFromUnixSeconds(futureTs[0]) : undefined;
  const remainingPercent = remainingFromUsed(usedPercent);

  return {
    success: true,
    status: 'ok',
    provider: 'grok',
    remainingPercent: remainingPercent ?? undefined,
    usedPercent,
    resetsAt,
    windows: [{
      id: 'credits',
      label: 'credits',
      remainingPercent: remainingPercent ?? undefined,
      usedPercent,
      resetsAt,
    }],
    fetchedAt: nowIso(),
  };
}

export async function fetchGrokQuota({ accessToken, fetchImpl = fetch } = {}) {
  if (!accessToken) throw new Error('oauth_not_logged_in');

  // 空 gRPC-web 消息帧：1 byte flags + 4 byte length(0)
  const emptyFrame = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00]);
  const response = await fetchImpl('https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/grpc-web+proto',
      Accept: 'application/grpc-web+proto',
      'X-Grpc-Web': '1',
      'X-User-Agent': 'PeerAgent/1.0',
      Origin: 'https://grok.com',
      Referer: 'https://grok.com/?_s=usage',
      'User-Agent': 'PeerAgent/1.0',
    },
    body: emptyFrame,
  });

  if (response.status === 401 || response.status === 403) {
    throw Object.assign(new Error('oauth_session_expired'), { code: 'oauth_session_expired' });
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw Object.assign(new Error(`quota_http_${response.status}:${text.slice(0, 160)}`), {
      code: 'quota_fetch_failed',
    });
  }

  const buffer = new Uint8Array(await response.arrayBuffer());
  return parseGrokGrpcWeb(buffer);
}

// ── Facade ──────────────────────────────────────────────────────────────

export function supportsSubscriptionQuota(authMethod) {
  return OAUTH_METHODS.has(authMethod);
}

export async function fetchProviderSubscriptionQuota({
  providerId,
  llmConfigStore,
  force = false,
  fetchImpl = fetch,
  resolveCredential = resolveProviderCredential,
} = {}) {
  if (!providerId) return failure('invalid_request', 'provider id required');
  const providers = llmConfigStore.listProviders() || [];
  const provider = providers.find((item) => item.id === providerId) || null;
  if (!provider) return failure('not_found', 'Provider not found');

  const authMethod = provider.authMethod || 'api_key';
  if (!supportsSubscriptionQuota(authMethod)) {
    return failure('unsupported', 'Subscription quota is only available for ChatGPT / Gemini / Grok OAuth');
  }

  if (provider.oauthStatus?.status === 'disconnected') {
    return failure('not_logged_in', 'Not logged in');
  }

  const credentialId = provider.credentialId || provider.groupId || provider.id;
  const cacheKey = `${credentialId}:${authMethod}`;
  const cached = quotaCache.get(cacheKey);
  if (!force && cached && cached.expiresAt > Date.now()) {
    return { ...cached.result, cached: true };
  }
  // TTL 过期后仍优先回上次成功结果，让 UI 能先渲染再静默 force 刷新。
  if (!force) {
    const lastSuccess = lastSuccessByKey.get(cacheKey);
    if (lastSuccess?.success) {
      return { ...lastSuccess, cached: true };
    }
  }

  try {
    const credential = await resolveCredential({ provider, llmConfigStore });
    const accessToken = credential.apiKey;
    const accountId = credential.accountId || provider.oauthStatus?.accountId || null;
    const stored = llmConfigStore.getCredential?.(credentialId) || null;
    const projectId = stored?.oauthProjectId || null;

    let result;
    if (authMethod === 'oauth_chatgpt') {
      result = await fetchChatGptUsage({ accessToken, accountId, fetchImpl });
    } else if (authMethod === 'oauth_google') {
      result = await fetchGeminiQuota({ accessToken, projectId, fetchImpl });
    } else if (authMethod === 'oauth_grok') {
      result = await fetchGrokQuota({ accessToken, fetchImpl });
    } else {
      return failure('unsupported', 'Unsupported auth method');
    }

    result = {
      ...result,
      providerId,
      authMethod,
      accountId: accountId || undefined,
    };
    quotaCache.set(cacheKey, { expiresAt: Date.now() + QUOTA_TTL_MS, result });
    if (result.success) {
      lastSuccessByKey.set(cacheKey, result);
    }
    return result;
  } catch (error) {
    const code = error?.code || getProviderCredentialErrorCode(error) || 'quota_fetch_failed';
    if (code === 'oauth_not_logged_in') return failure('not_logged_in', error.message);
    if (code === 'oauth_session_expired' || code === 'oauth_token_refresh_failed') {
      return failure('session_expired', error.message || 'Session expired');
    }
    return failure(code === 'quota_parse_failed' ? 'parse_failed' : 'fetch_failed', error?.message || 'Quota fetch failed');
  }
}

export function clearSubscriptionQuotaCache() {
  quotaCache.clear();
  lastSuccessByKey.clear();
}

/** 仅让新鲜 TTL 失效，保留 lastSuccess（测试/调试用）。 */
export function expireFreshSubscriptionQuotaCache() {
  for (const [key, entry] of quotaCache.entries()) {
    quotaCache.set(key, { ...entry, expiresAt: 0 });
  }
}
