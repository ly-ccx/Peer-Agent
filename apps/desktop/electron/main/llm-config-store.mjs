import electron from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathOf } from './data-store.mjs';
import { deriveOAuthStatus, resolveSubscriptionTestResult } from './provider-connectivity.mjs';
import {
  DEFAULT_SUBSCRIPTION_MODEL,
  SUBSCRIPTION_MODEL_IDS,
  SUBSCRIPTION_CATALOG,
  getSubscriptionModelMetadata,
} from './provider-adapters/openai-model-catalog.mjs';
import {
  CHATGPT_SUBSCRIPTION_BASE_URL,
  CHATGPT_SUBSCRIPTION_NAME,
  GEMINI_OAUTH_NAME,
  QODER_PRIVATE_NAME,
  defaultsForChannel,
  inferChannelId,
  legacyProviderForWire,
  resolveChannel,
  validateCustomHeaders,
} from './provider-channels.mjs';
import { loadQoderAccessToken } from './provider-adapters/qoder-local-auth.mjs';
import { getQoderModelCatalog, getQoderModelMetadata } from './provider-adapters/qoder-model-catalog.mjs';
import { sendQoderPrivateStream } from './provider-adapters/qoder-private-adapter.mjs';
import { expandQoderProviders } from './provider-adapters/qoder-provider-expansion.mjs';
import { expandSubscriptionProviders } from './provider-adapters/subscription-provider-expansion.mjs';

const { safeStorage } = electron;

function encrypt(plaintext) {
  if (!plaintext) return { encrypted: false, data: '' };
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const buf = safeStorage.encryptString(plaintext);
      return { encrypted: true, data: buf.toString('base64') };
    }
  } catch {
    console.warn('[llm-config] safeStorage unavailable, storing key in plaintext');
  }
  return { encrypted: false, data: plaintext };
}

function decrypt(stored) {
  if (!stored || !stored.data) return '';
  if (!stored.encrypted) return stored.data;
  try {
    return safeStorage.decryptString(Buffer.from(stored.data, 'base64'));
  } catch {
    console.warn('[llm-config] failed to decrypt key, returning empty');
    return '';
  }
}

function maskApiKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '...' + key.slice(-4);
}

// 为复制出的副本生成不重名的名称：中文用「副本」后缀，英文用「(Copy)」后缀，
// 已存在同名时智能追加序号(副本、副本 2、副本 3…)。复制副本时先剥离已有后缀，
// 避免「x 副本 副本」叠加。
function nextCopyName(rawName, existingNames) {
  const taken = new Set((existingNames || []).map((n) => String(n)));
  const name = String(rawName || '').trim() || 'Untitled';
  const isCJK = /[\u4e00-\u9fff]/.test(name);
  if (isCJK) {
    const base = name.replace(/\s*副本(\s*\d+)?$/, '').trim() || name;
    let candidate = `${base} 副本`;
    let n = 2;
    while (taken.has(candidate)) {
      candidate = `${base} 副本 ${n}`;
      n += 1;
    }
    return candidate;
  }
  const base = name.replace(/\s*\(Copy(\s*\d+)?\)$/i, '').trim() || name;
  let candidate = `${base} (Copy)`;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${base} (Copy ${n})`;
    n += 1;
  }
  return candidate;
}

const PROVIDER_DEFAULTS = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-20250514' },
};

// 订阅 token 集合以加密 JSON 形态存于 item.oauthTokens。
function decryptTokens(stored) {
  const raw = decrypt(stored);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// 由存储的 token 推导对外可见的登录态(不泄漏 token 本身)。
function oauthStatusOf(item) {
  if (item.authMethod !== 'oauth_chatgpt' && item.authMethod !== 'oauth_google') return undefined;
  return deriveOAuthStatus(decryptTokens(item.oauthTokens));
}

function normalizeAuthMethod(value) {
  if (value === 'oauth_chatgpt') return 'oauth_chatgpt';
  if (value === 'oauth_google') return 'oauth_google';
  if (value === 'qoder_local_auth' || value === 'local_cli') return 'qoder_local_auth';
  return 'api_key';
}

function isOAuthAuthMethod(value) {
  return value === 'oauth_chatgpt' || value === 'oauth_google';
}

function isLocalCliAuthMethod(value) {
  return value === 'qoder_local_auth' || value === 'local_cli';
}

function applyQoderModelMetadata(item) {
  const metadata = getQoderModelMetadata(item.model);
  if (metadata?.label) item.modelLabel = metadata.label;
  item.contextWindow = metadata?.contextWindow ?? item.contextWindow;
  item.maxOutputTokens = metadata?.maxOutputTokens ?? item.maxOutputTokens;
  item.supportsVision = metadata?.supportsVision ?? false;
  item.supportsReasoning = metadata?.supportsReasoning ?? false;
  item.supportsPromptCaching = false;
  item.cacheWritePrice = undefined;
  item.cacheReadPrice = undefined;
  item.customHeaders = undefined;
  item.reasoningParamStyle = undefined;
  item.reasoningEffortMap = undefined;
}

function applyExplicitModelMetadataPatch(item, patch) {
  if (patch.modelLabel !== undefined) {
    const modelLabel = String(patch.modelLabel || '').trim();
    if (modelLabel) item.modelLabel = modelLabel;
    else delete item.modelLabel;
  }
  if (patch.contextWindow !== undefined) item.contextWindow = patch.contextWindow || undefined;
  if (patch.maxOutputTokens !== undefined) item.maxOutputTokens = patch.maxOutputTokens || undefined;
  if (patch.supportsVision !== undefined) item.supportsVision = patch.supportsVision;
  if (patch.supportsReasoning !== undefined) item.supportsReasoning = patch.supportsReasoning;
}

export function createLlmConfigStore({ configFile = pathOf('llmProviders') } = {}) {
  // 订阅(codex 平面)provider 的就地迁移:
  // - 旧版默认 model 是 gpt-5 / gpt-5-codex(按量计费命名),订阅平面已不适用;
  //   非合法订阅 id 一律纠正为权威默认(gpt-5.5)。
  // - 订阅链路原生支持思考强度(reasoning),历史记录里 supportsReasoning 多为 false,
  //   统一开启,使聊天区出现思考强度档位。
  // 返回是否发生改动,供 readAll 决定是否回写。
  function applySubscriptionModelMetadata(item) {
    const metadata = getSubscriptionModelMetadata(item?.model);
    if (!metadata) return false;
    let changed = false;
    const fields = [
      'contextWindow',
      'maxOutputTokens',
      'inputPrice',
      'outputPrice',
      'cacheReadPrice',
      'longContextInputThreshold',
      'longContextInputPrice',
      'longContextCacheReadPrice',
      'longContextOutputPrice',
    ];
    for (const field of fields) {
      if (metadata[field] !== undefined && item[field] !== metadata[field]) {
        item[field] = metadata[field];
        changed = true;
      }
    }
    // OpenAI cached input pricing is represented by cacheReadPrice; there is no
    // separate cache-write charge in the public pricing table.
    if (item.cacheWritePrice !== undefined) {
      item.cacheWritePrice = undefined;
      changed = true;
    }
    const supportsPromptCaching = Boolean(metadata.cacheReadPrice);
    if (item.supportsPromptCaching !== supportsPromptCaching) {
      item.supportsPromptCaching = supportsPromptCaching;
      changed = true;
    }
    return changed;
  }

  function migrateSubscriptionItem(item) {
    if (!item || item.authMethod !== 'oauth_chatgpt') return false;
    let changed = false;
    if (!item.model || !SUBSCRIPTION_MODEL_IDS.has(item.model)) {
      item.model = DEFAULT_SUBSCRIPTION_MODEL;
      changed = true;
    }
    if (item.supportsReasoning !== true) {
      item.supportsReasoning = true;
      changed = true;
    }
    if (applySubscriptionModelMetadata(item)) changed = true;
    return changed;
  }

  function migrateChannelItem(item) {
    if (!item || typeof item !== 'object') return false;
    let changed = false;
    if (!item.channelId) {
      item.channelId = inferChannelId(item);
      changed = true;
    }
    if (item.authMethod === 'oauth_chatgpt') {
      if (item.channelId !== 'openai') {
        item.channelId = 'openai';
        changed = true;
      }
      if (item.wireOverride !== undefined) {
        delete item.wireOverride;
        changed = true;
      }
    }
    if (item.authMethod === 'oauth_google') {
      if (item.channelId !== 'google-ai') {
        item.channelId = 'google-ai';
        changed = true;
      }
      if (item.wireOverride !== undefined) {
        delete item.wireOverride;
        changed = true;
      }
    }
    if (item.authMethod === 'local_cli') {
      item.authMethod = 'qoder_local_auth';
      changed = true;
    }
    if (item.authMethod === 'qoder_local_auth') {
      if (item.channelId !== 'qoder') {
        item.channelId = 'qoder';
        changed = true;
      }
      if (item.wireOverride !== undefined) {
        delete item.wireOverride;
        changed = true;
      }
      if (item.apiKey?.data) {
        item.apiKey = encrypt('');
        changed = true;
      }
      const before = JSON.stringify({
        contextWindow: item.contextWindow,
        maxOutputTokens: item.maxOutputTokens,
        supportsVision: item.supportsVision,
        supportsReasoning: item.supportsReasoning,
        supportsPromptCaching: item.supportsPromptCaching,
      });
      applyQoderModelMetadata(item);
      const after = JSON.stringify({
        contextWindow: item.contextWindow,
        maxOutputTokens: item.maxOutputTokens,
        supportsVision: item.supportsVision,
        supportsReasoning: item.supportsReasoning,
        supportsPromptCaching: item.supportsPromptCaching,
      });
      if (before !== after) changed = true;
    }
    if (item.customHeaders && typeof item.customHeaders === 'object') {
      try {
        validateCustomHeaders(item.customHeaders);
      } catch {
        item.customHeadersInvalid = true;
        changed = true;
      }
    }
    return changed;
  }

  // B-2 多模型分组迁移:旧数据每条记录都是独立的 provider+单模型,
  // 缺 groupId。这里让每条旧记录自成一组(groupId = 自身 id),
  // 语义与迁移前完全一致(一个 provider 一个模型),不动加密密钥、零风险。
  function migrateGroupId(item) {
    if (!item || typeof item !== 'object') return false;
    if (typeof item.groupId === 'string' && item.groupId) return false;
    item.groupId = item.id;
    return true;
  }

  function readAll() {
    if (!existsSync(configFile)) return [];
    try {
      const parsed = JSON.parse(readFileSync(configFile, 'utf8'));
      if (!Array.isArray(parsed)) return [];
      let migrated = false;
      for (const item of parsed) {
        if (migrateChannelItem(item)) migrated = true;
        if (migrateSubscriptionItem(item)) migrated = true;
        if (migrateGroupId(item)) migrated = true;
      }
      if (migrated) {
        try { writeAll(parsed); } catch { /* 回写失败不影响本次读取 */ }
      }
      return parsed;
    } catch {
      return [];
    }
  }

  function writeAll(items) {
    mkdirSync(path.dirname(configFile), { recursive: true });
    writeFileSync(configFile, JSON.stringify(items, null, 2), 'utf8');
  }

  function toView(item) {
    const key = decrypt(item.apiKey);
    const oauthClientSecret = decrypt(item.oauthClientSecret);
    const resolved = (() => {
      try {
        const authToken = isOAuthAuthMethod(item.authMethod)
          ? (decryptTokens(item.oauthTokens)?.access || '')
          : key;
        return resolveChannel({ ...item, apiKey: authToken, accountId: oauthStatusOf(item)?.accountId });
      } catch {
        return null;
      }
    })();
    return {
      id: item.id,
      groupId: item.groupId || item.id,
      provider: item.provider,
      channelId: item.channelId || inferChannelId(item),
      resolvedWire: resolved?.wire,
      wireOverride: item.wireOverride,
      authMethod: item.authMethod || 'api_key',
      oauthStatus: oauthStatusOf(item),
      name: item.name,
      baseUrl: item.baseUrl,
      model: item.model,
      modelLabel: item.modelLabel || undefined,
      enabled: item.enabled,
      isDefault: item.isDefault,
      createdAt: item.createdAt,
      contextWindow: item.contextWindow || undefined,
      maxOutputTokens: item.maxOutputTokens || undefined,
      inputPrice: item.inputPrice ?? undefined,
      outputPrice: item.outputPrice ?? undefined,
      cacheWritePrice: item.cacheWritePrice ?? undefined,
      cacheReadPrice: item.cacheReadPrice ?? undefined,
      longContextInputThreshold: item.longContextInputThreshold ?? undefined,
      longContextInputPrice: item.longContextInputPrice ?? undefined,
      longContextCacheReadPrice: item.longContextCacheReadPrice ?? undefined,
      longContextOutputPrice: item.longContextOutputPrice ?? undefined,
      supportsVision: item.supportsVision ?? false,
      supportsReasoning: item.supportsReasoning ?? false,
      supportsPromptCaching: item.supportsPromptCaching ?? false,
      reasoningParamStyle: item.reasoningParamStyle ?? resolved?.reasoningParamStyle,
      reasoningEffortMap: item.reasoningEffortMap ?? resolved?.reasoningEffortMap ?? undefined,
      reasoningEffortLevels: item.reasoningEffortLevels ?? resolved?.reasoningEffortLevels ?? undefined,
      oauthClientId: item.oauthClientId ?? undefined,
      oauthProjectId: item.oauthProjectId ?? undefined,
      customHeaders: item.customHeaders ?? undefined,
      customHeadersInvalid: item.customHeadersInvalid ?? undefined,
      apiKeyMasked: maskApiKey(key),
      // 订阅链路无 API Key,凭据是否就绪以 OAuth 登录态(connected)为准；
      // 本机 CLI 链路的登录态由外部应用维护,Peer Agent 只检查命令与登录态是否可用。
      apiKeyConfigured:
        isLocalCliAuthMethod(item.authMethod)
          ? true
          : isOAuthAuthMethod(item.authMethod)
          ? oauthStatusOf(item)?.status === 'connected'
          : Boolean(key),
      oauthClientSecretConfigured: Boolean(oauthClientSecret),
    };
  }

  function listProviders() {
    return readAll().map(toView);
  }

  // 聊天/路由专用列表：在真实记录基础上，把每条 Qoder 本机记录展开成「该 provider 目录下的
  // 全部模型」多条虚拟记录（复合 id=groupId::modelId，共享同一凭证）。设置页仍走 listProviders()，
  // 因此这里的展开不会污染 CRUD。catalog 读取失败时 expandQoderProviders 会保留原单条记录。
  function listChatProviders() {
    // 先做订阅展开（ChatGPT OAuth 单记录 → 全部订阅模型多条虚拟记录，各带 credentialId 回退凭证），
    // 再做 Qoder 展开；两者对彼此的记录都原样透传，互不影响。设置页仍走 listProviders()（不展开）。
    const subscriptionExpanded = expandSubscriptionProviders(listProviders(), () => SUBSCRIPTION_CATALOG);
    return expandQoderProviders(subscriptionExpanded, () => getQoderModelCatalog());
  }

  function addProvider({ provider, groupId: rawGroupId, channelId: rawChannelId, wireOverride, authMethod, name, baseUrl, model, apiKey, contextWindow, maxOutputTokens, inputPrice, outputPrice, cacheWritePrice, cacheReadPrice, supportsVision, supportsReasoning, supportsPromptCaching, reasoningParamStyle, reasoningEffortMap, oauthClientId, oauthClientSecret, oauthProjectId, customHeaders }) {
    const items = readAll();
    const method = normalizeAuthMethod(authMethod);
    const channelId = method === 'oauth_chatgpt'
      ? 'openai'
      : method === 'oauth_google'
        ? 'google-ai'
        : method === 'qoder_local_auth'
          ? 'qoder'
          : (rawChannelId || inferChannelId({ provider, authMethod: method }));
    const defaults = rawChannelId ? defaultsForChannel(channelId) : (PROVIDER_DEFAULTS[provider] || defaultsForChannel(channelId));
    if (customHeaders) validateCustomHeaders(customHeaders);
    // 订阅(OAuth)身份写死:名称/baseURL 固定,不接受外部传入。model 留待登录后选择。
    const isSubscription = method === 'oauth_chatgpt';
    const isGoogleOAuth = method === 'oauth_google';
    const isLocalQoderAuth = method === 'qoder_local_auth';
    const selectedModel = model || (isSubscription ? DEFAULT_SUBSCRIPTION_MODEL : defaults.model);
    const subscriptionMetadata = isSubscription ? getSubscriptionModelMetadata(selectedModel) : null;
    const resolved = resolveChannel({
      channelId,
      wireOverride,
      authMethod: method,
      baseUrl: isSubscription ? CHATGPT_SUBSCRIPTION_BASE_URL : (isLocalQoderAuth ? defaults.baseUrl : (baseUrl || defaults.baseUrl)),
      apiKey: isSubscription || isGoogleOAuth || isLocalQoderAuth ? '' : (apiKey || ''),
      supportsReasoning: isSubscription ? true : (isLocalQoderAuth ? false : (supportsReasoning ?? false)),
      supportsPromptCaching: isSubscription ? Boolean(subscriptionMetadata?.cacheReadPrice) : (isLocalQoderAuth ? false : (supportsPromptCaching ?? false)),
      supportsVision,
      reasoningParamStyle,
      reasoningEffortMap,
      oauthProjectId,
      customHeaders,
    });
    const newId = randomUUID();
    const item = {
      id: newId,
      // 传了 groupId 则归入已有组(同组共享凭证,是该 provider 的又一个模型);
      // 不传则自成一组。
      groupId: (typeof rawGroupId === 'string' && rawGroupId) ? rawGroupId : newId,
      provider: provider || resolved.legacyProvider,
      channelId,
      wireOverride: isSubscription || isGoogleOAuth || isLocalQoderAuth ? undefined : wireOverride,
      authMethod: method,
      name: isSubscription ? CHATGPT_SUBSCRIPTION_NAME : isGoogleOAuth ? (name || GEMINI_OAUTH_NAME) : isLocalQoderAuth ? (name || QODER_PRIVATE_NAME) : name || provider || 'Untitled',
      baseUrl: isSubscription ? CHATGPT_SUBSCRIPTION_BASE_URL : isLocalQoderAuth ? defaults.baseUrl : baseUrl || defaults.baseUrl,
      // 订阅默认落到权威清单的最新模型(gpt-5.5),非订阅沿用各家 preset。
      model: selectedModel,
      apiKey: encrypt(isSubscription || isGoogleOAuth || isLocalQoderAuth ? '' : apiKey || ''),
      oauthClientId: isGoogleOAuth ? String(oauthClientId || '').trim() || undefined : undefined,
      oauthClientSecret: encrypt(isGoogleOAuth ? String(oauthClientSecret || '') : ''),
      oauthProjectId: isGoogleOAuth ? String(oauthProjectId || '').trim() || undefined : undefined,
      oauthTokens: encrypt(''),
      enabled: true,
      isDefault: items.length === 0,
      createdAt: new Date().toISOString(),
      contextWindow: isSubscription ? subscriptionMetadata?.contextWindow : (contextWindow || undefined),
      maxOutputTokens: isSubscription ? subscriptionMetadata?.maxOutputTokens : (maxOutputTokens || undefined),
      inputPrice: isSubscription ? subscriptionMetadata?.inputPrice : (inputPrice ?? undefined),
      outputPrice: isSubscription ? subscriptionMetadata?.outputPrice : (outputPrice ?? undefined),
      cacheWritePrice: isSubscription || isLocalQoderAuth ? undefined : (cacheWritePrice ?? undefined),
      cacheReadPrice: isSubscription ? subscriptionMetadata?.cacheReadPrice : (cacheReadPrice ?? undefined),
      longContextInputThreshold: isSubscription ? subscriptionMetadata?.longContextInputThreshold : undefined,
      longContextInputPrice: isSubscription ? subscriptionMetadata?.longContextInputPrice : undefined,
      longContextCacheReadPrice: isSubscription ? subscriptionMetadata?.longContextCacheReadPrice : undefined,
      longContextOutputPrice: isSubscription ? subscriptionMetadata?.longContextOutputPrice : undefined,
      supportsVision: isLocalQoderAuth ? false : (supportsVision ?? false),
      // 订阅链路(codex/responses)原生支持思考强度,默认开启。
      supportsReasoning: isSubscription ? true : (isLocalQoderAuth ? false : (supportsReasoning ?? false)),
      supportsPromptCaching: isSubscription ? Boolean(subscriptionMetadata?.cacheReadPrice) : (isLocalQoderAuth ? false : (supportsPromptCaching ?? false)),
      reasoningParamStyle: reasoningParamStyle || undefined,
      reasoningEffortMap: resolved.reasoningEffortMap || undefined,
      customHeaders: customHeaders || undefined,
    };
    if (isLocalQoderAuth) applyQoderModelMetadata(item);
    item.provider = legacyProviderForWire(resolved.wire);
    items.push(item);
    writeAll(items);
    return toView(item);
  }

  function updateProvider(id, patch) {
    const items = readAll();
    const idx = items.findIndex((i) => i.id === id);
    if (idx < 0) throw new Error(`Provider ${id} not found`);
    const item = items[idx];
    if (patch.provider !== undefined) {
      item.provider = patch.provider;
      if (patch.channelId === undefined) {
        item.channelId = inferChannelId({ provider: patch.provider, authMethod: item.authMethod });
      }
    }
    if (patch.channelId !== undefined) item.channelId = patch.channelId;
    if (patch.wireOverride !== undefined) item.wireOverride = patch.wireOverride || undefined;
    if (patch.name !== undefined) item.name = patch.name;
    if (patch.baseUrl !== undefined) item.baseUrl = patch.baseUrl;
    if (patch.model !== undefined) {
      item.model = patch.model;
      delete item.modelLabel;
    }
    applyExplicitModelMetadataPatch(item, patch);
    if (patch.enabled !== undefined) item.enabled = patch.enabled;
    if (patch.apiKey !== undefined) item.apiKey = encrypt(patch.apiKey);
    if (patch.oauthClientId !== undefined) item.oauthClientId = patch.oauthClientId || undefined;
    if (patch.oauthClientSecret !== undefined) item.oauthClientSecret = encrypt(patch.oauthClientSecret || '');
    if (patch.oauthProjectId !== undefined) item.oauthProjectId = patch.oauthProjectId || undefined;
    if (patch.contextWindow !== undefined) item.contextWindow = patch.contextWindow || undefined;
    if (patch.maxOutputTokens !== undefined) item.maxOutputTokens = patch.maxOutputTokens || undefined;
    if (patch.inputPrice !== undefined) item.inputPrice = patch.inputPrice;
    if (patch.outputPrice !== undefined) item.outputPrice = patch.outputPrice;
    if (patch.cacheWritePrice !== undefined) item.cacheWritePrice = patch.cacheWritePrice;
    if (patch.cacheReadPrice !== undefined) item.cacheReadPrice = patch.cacheReadPrice;
    if (patch.supportsVision !== undefined) item.supportsVision = patch.supportsVision;
    if (patch.supportsReasoning !== undefined) item.supportsReasoning = patch.supportsReasoning;
    if (patch.supportsPromptCaching !== undefined) item.supportsPromptCaching = patch.supportsPromptCaching;
    if (patch.reasoningParamStyle !== undefined) item.reasoningParamStyle = patch.reasoningParamStyle || undefined;
    if (patch.reasoningEffortMap !== undefined) item.reasoningEffortMap = patch.reasoningEffortMap || undefined;
    if (patch.customHeaders !== undefined) {
      validateCustomHeaders(patch.customHeaders || {});
      item.customHeaders = patch.customHeaders || undefined;
      delete item.customHeadersInvalid;
    }
    if (item.authMethod === 'oauth_chatgpt') {
      item.name = CHATGPT_SUBSCRIPTION_NAME;
      item.baseUrl = CHATGPT_SUBSCRIPTION_BASE_URL;
      item.channelId = 'openai';
      delete item.wireOverride;
      item.provider = 'openai';
      item.supportsReasoning = true;
      applySubscriptionModelMetadata(item);
    }
    if (item.authMethod === 'oauth_google') {
      item.channelId = 'google-ai';
      delete item.wireOverride;
      item.provider = 'openai';
      item.baseUrl = item.baseUrl || defaultsForChannel('google-ai').baseUrl;
    }
    if (item.authMethod === 'qoder_local_auth' || item.authMethod === 'local_cli') {
      item.authMethod = 'qoder_local_auth';
      item.channelId = 'qoder';
      delete item.wireOverride;
      item.provider = 'openai';
      item.baseUrl = defaultsForChannel('qoder').baseUrl;
      item.apiKey = encrypt('');
      applyQoderModelMetadata(item);
      applyExplicitModelMetadataPatch(item, patch);
    }
    const resolved = resolveChannel({
      ...item,
      apiKey: isOAuthAuthMethod(item.authMethod)
        ? (decryptTokens(item.oauthTokens)?.access || '')
        : decrypt(item.apiKey),
      accountId: oauthStatusOf(item)?.accountId,
    });
    item.provider = legacyProviderForWire(resolved.wire);
    item.reasoningEffortMap = resolved.reasoningEffortMap || undefined;
    items[idx] = item;
    writeAll(items);
    return toView(item);
  }

  function removeProvider(id) {
    let items = readAll();
    const removed = items.find((i) => i.id === id);
    items = items.filter((i) => i.id !== id);
    if (removed?.isDefault && items.length > 0) {
      items[0].isDefault = true;
    }
    writeAll(items);
    return items.map(toView);
  }

  // B-2 删除整个 provider 组(同 groupId 的全部模型)。
  // 若删掉的组里含当前默认模型,则把剩余首条记录设为默认(与 removeProvider 一致)。
  function removeGroup(groupId) {
    let items = readAll();
    const removed = items.filter((i) => (i.groupId || i.id) === groupId);
    const hadDefault = removed.some((i) => i.isDefault);
    items = items.filter((i) => (i.groupId || i.id) !== groupId);
    if (hadDefault && items.length > 0) {
      items[0].isDefault = true;
    }
    writeAll(items);
    return items.map(toView);
  }

  function setDefault(id) {
    const items = readAll();
    // 防御:OAuth(订阅)类型且会话非 connected(过期/未登录)时,禁止设为默认。
    // 激活了也无法发起对话,只会在真正请求时才报错;前端已禁用按钮,此处兜住其它入口。
    const target = items.find((i) => i.id === id);
    if (target && isOAuthAuthMethod(target.authMethod)) {
      const status = oauthStatusOf(target)?.status;
      if (status !== 'connected') {
        throw new Error('OAUTH_SESSION_NOT_CONNECTED');
      }
    }
    for (const item of items) {
      item.isDefault = item.id === id;
    }
    writeAll(items);
    return items.map(toView);
  }

  // 复制一个已有 provider，生成可独立编辑的副本。
  // 订阅(OAuth)类型不允许复制：其身份绑定登录态/token，复制无意义且有安全风险。
  // 副本：新 id、不继承默认标记、不复制 OAuth token，名称智能去重。
  // apiKey 按产品决策随副本一起复制(密文深拷贝)，副本开箱即用。
  function duplicateProvider(id) {
    const items = readAll();
    const source = items.find((i) => i.id === id);
    if (!source) throw new Error(`Provider ${id} not found`);
    if (isOAuthAuthMethod(source.authMethod)) {
      throw new Error('Subscription providers cannot be duplicated');
    }
    const copy = {
      ...source,
      id: randomUUID(),
      name: nextCopyName(source.name, items.map((i) => i.name)),
      apiKey: source.apiKey ? { ...source.apiKey } : encrypt(''),
      oauthClientSecret: source.oauthClientSecret ? { ...source.oauthClientSecret } : encrypt(''),
      oauthTokens: encrypt(''),
      isDefault: false,
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    items.push(copy);
    writeAll(items);
    return toView(copy);
  }

  // B-2 在已有 provider 组内新增一个模型:凭证(apiKey/baseUrl/provider 归属)
  // 继承自组内首条记录,调用方无需重填 apiKey;模型级参数由 patch 提供。
  // 复用 addProvider 的完整 wire/channel/定价解析,保证路由字段正确。
  // 订阅(OAuth)类型与 duplicateProvider 一致:不支持多模型,直接拒绝。
  function addModel(groupId, patch = {}) {
    if (!groupId) throw new Error('groupId is required');
    const items = readAll();
    const source = items.find((i) => (i.groupId || i.id) === groupId);
    if (!source) throw new Error(`Provider group ${groupId} not found`);
    if (isOAuthAuthMethod(source.authMethod)) {
      throw new Error('Subscription providers cannot host multiple models');
    }
    const inheritedApiKey = decrypt(source.apiKey);
    return addProvider({
      // 凭证与 provider 归属继承自组内首条记录
      groupId,
      provider: source.provider,
      channelId: source.channelId,
      wireOverride: source.wireOverride,
      authMethod: source.authMethod || 'api_key',
      baseUrl: source.baseUrl,
      apiKey: inheritedApiKey,
      // 模型级参数来自 patch(缺省回退到 source,保证必填字段有值)
      name: patch.name || source.name,
      model: patch.model || source.model,
      contextWindow: patch.contextWindow,
      maxOutputTokens: patch.maxOutputTokens,
      inputPrice: patch.inputPrice,
      outputPrice: patch.outputPrice,
      cacheWritePrice: patch.cacheWritePrice,
      cacheReadPrice: patch.cacheReadPrice,
      supportsVision: patch.supportsVision,
      supportsReasoning: patch.supportsReasoning,
      supportsPromptCaching: patch.supportsPromptCaching,
      reasoningParamStyle: patch.reasoningParamStyle,
      reasoningEffortMap: patch.reasoningEffortMap,
      customHeaders: patch.customHeaders,
    });
  }

  function getDecryptedApiKey(id) {
    const items = readAll();
    const item = items.find((i) => i.id === id);
    if (!item) return null;
    return decrypt(item.apiKey);
  }

  // 返回订阅凭据 { tokens },tokens 为解密后的 OAuth token 集合。
  function getCredential(id) {
    const items = readAll();
    const item = items.find((i) => i.id === id);
    if (!item) return null;
    return {
      tokens: decryptTokens(item.oauthTokens),
      oauthClientId: item.oauthClientId,
      oauthClientSecret: decrypt(item.oauthClientSecret),
      oauthProjectId: item.oauthProjectId,
      authMethod: item.authMethod,
    };
  }

  // 返回 api_key provider 拉列模型所需的请求配置(wire / baseUrl / headers / apiKey)。
  //
  // 复用 resolveChannel 已经拼装好的 headers(含 Authorization / x-api-key /
  // anthropic-version / customHeaders 等),避免在上层重复实现"如何认证 OpenAI 兼容
  // 网关"这套散落逻辑。仅面向 authMethod='api_key';OAuth/本机 CLI provider 走各自
  // 的适配器,不通过此方法。
  //
  // 返回 null 的三种情况:
  // - provider 不存在
  // - provider 不是 api_key 认证方式
  // - apiKey 未配置(空字符串)
  function getApiKeyRequestConfig(id) {
    const items = readAll();
    const item = items.find((i) => i.id === id);
    if (!item) return null;
    if (isOAuthAuthMethod(item.authMethod) || isLocalCliAuthMethod(item.authMethod)) return null;
    const apiKey = decrypt(item.apiKey);
    if (!apiKey) return null;
    const resolved = resolveChannel({ ...item, apiKey });
    return {
      wire: resolved.wire,
      baseUrl: resolved.baseUrl,
      headers: resolved.headers,
      apiKey,
    };
  }

  // 写入/刷新订阅 token 集合(整体加密存储)。tokens 形如
  // { access, refresh, expires, accountId }。
  function setOAuthTokens(id, tokens) {
    const items = readAll();
    const idx = items.findIndex((i) => i.id === id);
    if (idx < 0) throw new Error(`Provider ${id} not found`);
    items[idx].oauthTokens = encrypt(tokens ? JSON.stringify(tokens) : '');
    writeAll(items);
    return toView(items[idx]);
  }

  async function testConnection(id) {
    const items = readAll();
    const item = items.find((i) => i.id === id);
    if (!item) return { success: false, error: 'Provider not found' };

    // 订阅(ChatGPT OAuth)provider 不持有 apiKey；连通性以 OAuth 登录态为准。
    // 真正的远程模型探测走 `llm:models:list`(main 层,含 token 刷新)，此处只判定凭证有效性，
    // 避免存储层反向依赖 provider 网络适配器，也避免对订阅误报 "API key not configured"。
    if (isOAuthAuthMethod(item.authMethod)) {
      return resolveSubscriptionTestResult(oauthStatusOf(item), item.model);
    }

    if (isLocalCliAuthMethod(item.authMethod)) {
      return testQoderPrivate(item.model);
    }

    const apiKey = decrypt(item.apiKey);
    if (!apiKey) return { success: false, error: 'API key not configured' };

    const start = Date.now();
    try {
      const resolved = resolveChannel({ ...item, apiKey });
      if (resolved.wire === 'anthropic-messages') {
        return await testAnthropic(resolved, item.model, start);
      }
      if (resolved.wire === 'openai-responses') {
        return await testOpenAIResponses(resolved, item.model, start);
      }
      if (resolved.wire === 'gemini') {
        return await testGemini(resolved, item.model, start);
      }
      return await testOpenAI(resolved, item.model, start);
    } catch (err) {
      return { success: false, error: err?.message || 'Connection failed', latencyMs: Date.now() - start };
    }
  }

  return { listProviders, listChatProviders, addProvider, addModel, updateProvider, duplicateProvider, removeProvider, removeGroup, setDefault, getDecryptedApiKey, getCredential, getApiKeyRequestConfig, setOAuthTokens, testConnection };
}

async function testOpenAI(resolved, model, start) {
  const url = resolved.endpoint;
  const res = await fetch(url, {
    method: 'POST',
    headers: resolved.headers,
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const latencyMs = Date.now() - start;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { success: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}`, latencyMs };
  }
  const data = await res.json();
  return { success: true, model: data.model || model, latencyMs };
}

async function testOpenAIResponses(resolved, model, start) {
  const res = await fetch(resolved.endpoint, {
    method: 'POST',
    headers: resolved.headers,
    body: JSON.stringify({
      model,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      max_output_tokens: 1,
      store: false,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const latencyMs = Date.now() - start;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { success: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}`, latencyMs };
  }
  const data = await res.json();
  return { success: true, model: data.model || model, latencyMs };
}

async function testAnthropic(resolved, model, start) {
  const url = resolved.endpoint;
  const res = await fetch(url, {
    method: 'POST',
    headers: resolved.headers,
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const latencyMs = Date.now() - start;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { success: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}`, latencyMs };
  }
  const data = await res.json();
  return { success: true, model: data.model || model, latencyMs };
}

async function testGemini(resolved, model, start) {
  const res = await fetch(resolved.testEndpoint || resolved.endpoint, {
    method: 'POST',
    headers: resolved.headers,
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    }),
    signal: AbortSignal.timeout(15000),
  });
  const latencyMs = Date.now() - start;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { success: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}`, latencyMs };
  }
  await res.json().catch(() => ({}));
  return { success: true, model, latencyMs };
}

async function testQoderPrivate(model = 'auto') {
  const start = Date.now();
  try {
    const token = await loadQoderAccessToken();
    const result = await sendQoderPrivateStream({
      apiKey: token,
      model: model || 'auto',
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 8,
      signal: AbortSignal.timeout(15000),
      webContents: { send: () => {} },
      streamId: `llm-test-qoder-${Date.now()}`,
    });
    const latencyMs = Date.now() - start;
    if (!result.ok) {
      const error = result.errorText || (result.status ? `HTTP ${result.status}` : 'qoder_private_error');
      return { success: false, error, latencyMs };
    }
    if (!String(result.content || '').trim()) {
      return { success: false, error: 'qoder_private_empty_response', latencyMs };
    }
    return { success: true, model: model || 'auto', latencyMs };
  } catch (err) {
    return { success: false, error: err?.code || 'qoder_auth_unavailable', latencyMs: Date.now() - start };
  }
}
