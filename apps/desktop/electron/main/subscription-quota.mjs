// 订阅额度查询（GPT / Gemini / Grok / Qoder）。
// 数据源对齐 CodexBar：
// - GPT: ChatGPT backend wham/usage
// - Gemini: cloudcode-pa retrieveUserQuota
// - Grok: grok.com GrokBuildBilling GetGrokCreditsConfig
// - Qoder: qoder-agent-sdk session.getUsageInfo()
// 只在 main 进程运行；复用已有 OAuth / 本机登录态，不引入第三方依赖。

import { resolveProviderCredential, getProviderCredentialErrorCode } from './provider-credential-resolver.mjs';
import { fetchQoderUsageInfo } from './provider-adapters/qoder-official-model-catalog.mjs';
import { fetchWithConnectionRecovery } from './provider-transports/recovering-fetch.mjs';

const QUOTA_TTL_MS = 60_000;
/** 新鲜缓存：TTL 内直接返回，避免重复打供应商接口。 */
const quotaCache = new Map(); // cacheKey -> { expiresAt, result }
/**
 * 上次成功额度：进程生命周期内保留，TTL 过期后仍可先回给 UI，
 * 便于设置页进入时立刻展示「上次额度」，再后台 force 静默刷新。
 */
const lastSuccessByKey = new Map(); // cacheKey -> result

const OAUTH_METHODS = new Set(['oauth_chatgpt', 'oauth_google', 'oauth_grok']);
const LOCAL_CLI_METHODS = new Set(['qoder_local_auth', 'local_cli']);

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

export async function fetchChatGptUsage({ accessToken, accountId, fetchImpl = fetchWithConnectionRecovery } = {}) {
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


// ── Gemini Code Assist project resolution ──────────────────────────────
// 对齐 gemini-cli packages/core/src/code_assist/setup.ts：
// 1) loadCodeAssist 取 cloudaicompanionProject
// 2) 若尚未 onboard，则 onboardUser（free tier 不传 project）并轮询 LRO

const GEMINI_CODE_ASSIST_BASE = 'https://cloudcode-pa.googleapis.com/v1internal';
const GEMINI_CODE_ASSIST_METADATA = {
  ideType: 'IDE_UNSPECIFIED',
  platform: 'PLATFORM_UNSPECIFIED',
  pluginType: 'GEMINI',
};

function extractCloudAiCompanionProjectId(value) {
  if (!value) return null;
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'object') {
    const nested = value.id || value.projectId || value.name || null;
    if (typeof nested === 'string' && nested.trim()) return nested.trim();
  }
  return null;
}

async function postCodeAssistJson(fetchImpl, accessToken, method, body) {
  const response = await fetchImpl(`${GEMINI_CODE_ASSIST_BASE}:${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'PeerAgent/1.0',
    },
    body: JSON.stringify(body || {}),
  });
  const payload = await readJsonResponse(response);
  return { response, payload };
}

function pickDefaultOnboardTier(loadRes) {
  const tiers = Array.isArray(loadRes?.allowedTiers) ? loadRes.allowedTiers : [];
  const preferred = tiers.find((tier) => tier?.isDefault) || tiers[0] || null;
  return preferred;
}

export async function resolveGeminiCodeAssistProjectId({
  accessToken,
  projectId,
  fetchImpl = fetchWithConnectionRecovery,
  pollIntervalMs = 1000,
  maxPolls = 30,
} = {}) {
  if (!accessToken) throw new Error('oauth_not_logged_in');
  let resolvedProjectId = typeof projectId === 'string' && projectId.trim()
    ? projectId.trim()
    : null;

  const metadata = {
    ...GEMINI_CODE_ASSIST_METADATA,
    ...(resolvedProjectId ? { duetProject: resolvedProjectId } : {}),
  };

  let loadResponse;
  let loadRes;
  try {
    ({ response: loadResponse, payload: loadRes } = await postCodeAssistJson(
      fetchImpl,
      accessToken,
      'loadCodeAssist',
      {
        ...(resolvedProjectId ? { cloudaicompanionProject: resolvedProjectId } : {}),
        metadata,
      },
    ));
  } catch (error) {
    // 网络/代理失败时不要吞成“缺少 project”，否则用户会误判为账号未开通。
    const detail = error?.cause?.message || error?.message || String(error);
    throw new Error(`Gemini Code Assist loadCodeAssist 网络请求失败：${detail}`);
  }

  if (!loadResponse?.ok) {
    const status = loadResponse?.status || 'unknown';
    const message = loadRes?.error?.message
      || loadRes?.message
      || (typeof loadRes === 'string' ? loadRes : JSON.stringify(loadRes || {}));
    throw new Error(`Gemini Code Assist loadCodeAssist 失败（HTTP ${status}）：${message}`);
  }

  if (loadRes) {
    const fromLoad = extractCloudAiCompanionProjectId(
      loadRes.cloudaicompanionProject
        || loadRes.cloudAiCompanionProject
        || loadRes.projectId,
    );
    if (fromLoad) return fromLoad;

    // 已有 currentTier 但仍无 project：若调用方给了 projectId 可直接用。
    if (loadRes.currentTier && resolvedProjectId) return resolvedProjectId;

    // 未 onboard 时，尝试自动 onboard（个人免费档 / 默认档）。
    if (!loadRes.currentTier) {
      const tier = pickDefaultOnboardTier(loadRes);
      const tierId = tier?.id || 'free-tier';
      const isFreeTier = tierId === 'free-tier' || tierId === 'FREE';
      const onboardReq = isFreeTier
        ? {
            tierId,
            cloudaicompanionProject: undefined,
            metadata: GEMINI_CODE_ASSIST_METADATA,
          }
        : {
            tierId,
            cloudaicompanionProject: resolvedProjectId || undefined,
            metadata: {
              ...GEMINI_CODE_ASSIST_METADATA,
              ...(resolvedProjectId ? { duetProject: resolvedProjectId } : {}),
            },
          };

      let onboardResponse;
      let lroRes;
      try {
        ({ response: onboardResponse, payload: lroRes } = await postCodeAssistJson(
          fetchImpl,
          accessToken,
          'onboardUser',
          onboardReq,
        ));
      } catch (error) {
        const detail = error?.cause?.message || error?.message || String(error);
        throw new Error(`Gemini Code Assist onboardUser 网络请求失败：${detail}`);
      }
      if (!onboardResponse.ok) {
        const status = onboardResponse.status || 'unknown';
        const message = lroRes?.error?.message
          || lroRes?.message
          || JSON.stringify(lroRes || {});
        throw new Error(`Gemini Code Assist onboardUser 失败（HTTP ${status}）：${message}`);
      }

      let polls = 0;
      while (lroRes && !lroRes.done && lroRes.name && polls < maxPolls) {
        polls += 1;
        if (pollIntervalMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }
        // 对齐 gemini-cli：GET {base}/{operationName}
        const opUrl = lroRes.name.startsWith('http')
          ? lroRes.name
          : `${GEMINI_CODE_ASSIST_BASE}/${String(lroRes.name).replace(/^\/+/, '')}`;
        let opResponse;
        try {
          opResponse = await fetchImpl(opUrl, {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: 'application/json',
              'User-Agent': 'PeerAgent/1.0',
            },
          });
        } catch (error) {
          const detail = error?.cause?.message || error?.message || String(error);
          throw new Error(`Gemini Code Assist getOperation 网络请求失败：${detail}`);
        }
        if (!opResponse.ok) {
          throw new Error(`Gemini Code Assist getOperation 失败（HTTP ${opResponse.status}）`);
        }
        lroRes = await readJsonResponse(opResponse);
      }

      const fromOnboard = extractCloudAiCompanionProjectId(
        lroRes?.response?.cloudaicompanionProject
          || lroRes?.cloudaicompanionProject,
      );
      if (fromOnboard) return fromOnboard;
      if (resolvedProjectId) return resolvedProjectId;
    }
  }

  return resolvedProjectId;
}

// ── Gemini Code Assist (retrieveUserQuota) ──────────────────────────────

export async function fetchGeminiQuota({ accessToken, projectId, fetchImpl = fetchWithConnectionRecovery } = {}) {
  if (!accessToken) throw new Error('oauth_not_logged_in');

  // CodexBar：先 loadCodeAssist 拿 cloudaicompanionProject，再 retrieveUserQuota。
  const resolvedProjectId = await resolveGeminiCodeAssistProjectId({ accessToken, projectId, fetchImpl });

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

export async function fetchGrokQuota({ accessToken, fetchImpl = fetchWithConnectionRecovery } = {}) {
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
  return OAUTH_METHODS.has(authMethod) || LOCAL_CLI_METHODS.has(authMethod);
}

function finiteNumber(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function bucketRemainingPercent(bucket) {
  if (!bucket || typeof bucket !== 'object') return null;
  const percentage = finiteNumber(bucket.percentage);
  if (percentage != null) return clampPercent(100 - percentage);
  const remaining = finiteNumber(bucket.remaining);
  const total = finiteNumber(bucket.total ?? bucket.cap);
  if (remaining != null && total != null && total > 0) {
    return clampPercent((remaining / total) * 100);
  }
  const used = finiteNumber(bucket.used);
  if (used != null && total != null && total > 0) {
    return clampPercent(((total - used) / total) * 100);
  }
  return null;
}

/**
 * 将 Qoder SDK UsageInfo 映射为统一订阅额度快照。
 * 对齐 CLI /status：Plan Credits、Add-on Credits、Org Resource Package、Available Credits。
 */
export function mapQoderUsageToQuota(usage) {
  if (!usage || typeof usage !== 'object') {
    throw Object.assign(new Error('usage_parse_failed'), { code: 'quota_parse_failed' });
  }

  const userQuota = usage.userQuota && typeof usage.userQuota === 'object' ? usage.userQuota : null;
  const addOnQuota = usage.addOnQuota && typeof usage.addOnQuota === 'object' ? usage.addOnQuota : null;
  const orgPackage = usage.orgResourcePackage && typeof usage.orgResourcePackage === 'object'
    ? usage.orgResourcePackage
    : null;

  const planUsed = finiteNumber(userQuota?.used);
  const planTotal = finiteNumber(userQuota?.total);
  const planRemaining = finiteNumber(userQuota?.remaining)
    ?? (planUsed != null && planTotal != null ? Math.max(0, planTotal - planUsed) : null);

  const addOnUsed = finiteNumber(addOnQuota?.used);
  const addOnTotal = finiteNumber(addOnQuota?.total);
  const addOnRemaining = finiteNumber(addOnQuota?.remaining)
    ?? (addOnUsed != null && addOnTotal != null ? Math.max(0, addOnTotal - addOnUsed) : null);

  const orgUsed = finiteNumber(orgPackage?.used);
  const orgCap = finiteNumber(orgPackage?.cap ?? orgPackage?.total);
  const orgRemaining = finiteNumber(orgPackage?.remaining)
    ?? (orgUsed != null && orgCap != null ? Math.max(0, orgCap - orgUsed) : null);

  const availableCredits = [planRemaining, addOnRemaining, orgRemaining]
    .filter((value) => value != null)
    .reduce((sum, value) => sum + value, 0);

  const windows = [];
  if (userQuota) {
    windows.push({
      id: 'plan_credits',
      label: 'Plan Credits',
      remainingPercent: bucketRemainingPercent(userQuota) ?? undefined,
      usedPercent: clampPercent(finiteNumber(userQuota.percentage) ?? (
        planUsed != null && planTotal != null && planTotal > 0 ? (planUsed / planTotal) * 100 : null
      )) ?? undefined,
      resetsAt: typeof usage.expiresAt === 'string' ? usage.expiresAt : undefined,
    });
  }
  if (addOnQuota) {
    windows.push({
      id: 'addon_credits',
      label: 'Add-on Credits',
      remainingPercent: bucketRemainingPercent(addOnQuota) ?? undefined,
      usedPercent: clampPercent(finiteNumber(addOnQuota.percentage) ?? (
        addOnUsed != null && addOnTotal != null && addOnTotal > 0 ? (addOnUsed / addOnTotal) * 100 : null
      )) ?? undefined,
    });
  }
  if (orgPackage) {
    windows.push({
      id: 'org_resource_package',
      label: 'Org Resource Package',
      remainingPercent: bucketRemainingPercent({
        ...orgPackage,
        total: orgCap ?? orgPackage.total,
      }) ?? undefined,
      usedPercent: clampPercent(finiteNumber(orgPackage.percentage) ?? (
        orgUsed != null && orgCap != null && orgCap > 0 ? (orgUsed / orgCap) * 100 : null
      )) ?? undefined,
    });
  }

  const totalCap = [planTotal, addOnTotal, orgCap]
    .filter((value) => value != null)
    .reduce((sum, value) => sum + value, 0);
  const remainingPercent = totalCap > 0
    ? clampPercent((availableCredits / totalCap) * 100)
    : (bucketRemainingPercent(userQuota) ?? bucketRemainingPercent(orgPackage));
  const usedPercent = remainingPercent == null ? null : clampPercent(100 - remainingPercent);

  if (windows.length === 0 && availableCredits <= 0 && remainingPercent == null) {
    throw Object.assign(new Error('usage_parse_failed'), { code: 'quota_parse_failed' });
  }

  return {
    success: true,
    status: 'ok',
    provider: 'qoder',
    planLabel: typeof usage.userType === 'string' && usage.userType.trim()
      ? usage.userType.trim()
      : undefined,
    remainingPercent: remainingPercent ?? undefined,
    usedPercent: usedPercent ?? undefined,
    resetsAt: typeof usage.expiresAt === 'string' ? usage.expiresAt : undefined,
    windows: windows.length ? windows : undefined,
    fetchedAt: nowIso(),
    availableCredits: availableCredits > 0 || planRemaining != null || orgRemaining != null
      ? availableCredits
      : undefined,
    planCreditsUsed: planUsed ?? undefined,
    planCreditsTotal: planTotal ?? undefined,
    orgPackageUsed: orgUsed ?? undefined,
    orgPackageCap: orgCap ?? undefined,
    accountId: typeof usage.userId === 'string' ? usage.userId : undefined,
  };
}

export async function fetchQoderQuota({ usageLoader = fetchQoderUsageInfo, ...options } = {}) {
  const usage = await usageLoader(options);
  return mapQoderUsageToQuota(usage);
}

export async function fetchProviderSubscriptionQuota({
  providerId,
  llmConfigStore,
  force = false,
  fetchImpl = fetchWithConnectionRecovery,
  resolveCredential = resolveProviderCredential,
} = {}) {
  if (!providerId) return failure('invalid_request', 'provider id required');
  const providers = llmConfigStore.listProviders() || [];
  const provider = providers.find((item) => item.id === providerId) || null;
  if (!provider) return failure('not_found', 'Provider not found');

  const authMethod = provider.authMethod || 'api_key';
  if (!supportsSubscriptionQuota(authMethod)) {
    return failure('unsupported', 'Subscription quota is only available for ChatGPT / Gemini / Grok OAuth or Qoder CLI login');
  }

  const isLocalCli = LOCAL_CLI_METHODS.has(authMethod);
  if (!isLocalCli && provider.oauthStatus?.status === 'disconnected') {
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
    let result;
    let accountId = provider.oauthStatus?.accountId || null;

    if (isLocalCli) {
      result = await fetchQoderQuota();
      accountId = result.accountId || accountId;
    } else {
      const credential = await resolveCredential({ provider, llmConfigStore });
      const accessToken = credential.apiKey;
      accountId = credential.accountId || accountId;
      const stored = llmConfigStore.getCredential?.(credentialId) || null;
      const projectId = stored?.oauthProjectId || null;

      if (authMethod === 'oauth_chatgpt') {
        result = await fetchChatGptUsage({ accessToken, accountId, fetchImpl });
      } else if (authMethod === 'oauth_google') {
        result = await fetchGeminiQuota({ accessToken, projectId, fetchImpl });
      } else if (authMethod === 'oauth_grok') {
        result = await fetchGrokQuota({ accessToken, fetchImpl });
      } else {
        return failure('unsupported', 'Unsupported auth method');
      }
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
    if (code === 'oauth_not_logged_in' || code === 'qoder_cli_not_found') {
      return failure('not_logged_in', error.message || 'Not logged in');
    }
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
