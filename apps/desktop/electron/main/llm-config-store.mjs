import electron from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathOf } from './data-store.mjs';
import { deriveOAuthStatus, resolveSubscriptionTestResult } from './provider-connectivity.mjs';
import {
  DEFAULT_SUBSCRIPTION_MODEL,
  SUBSCRIPTION_MODEL_IDS,
  getSubscriptionModelMetadata,
} from './provider-adapters/openai-model-catalog.mjs';
import { buildClaudeCliIdentityHeaders } from './provider-adapters/anthropic-cli-identity.mjs';

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

// ChatGPT 订阅(OAuth)写死的固定身份(ADR 28)。
// - baseUrl 沿用 opencode 的 Codex 订阅端点;Responses adapter 会在其后拼 `/responses`。
// - 显示名固定,UI 不暴露给用户编辑。
const CHATGPT_SUBSCRIPTION_NAME = 'ChatGPT 订阅';
const CHATGPT_SUBSCRIPTION_BASE_URL = 'https://chatgpt.com/backend-api/codex';

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
  if (item.authMethod !== 'oauth_chatgpt') return undefined;
  return deriveOAuthStatus(decryptTokens(item.oauthTokens));
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

  function readAll() {
    if (!existsSync(configFile)) return [];
    try {
      const parsed = JSON.parse(readFileSync(configFile, 'utf8'));
      if (!Array.isArray(parsed)) return [];
      let migrated = false;
      for (const item of parsed) {
        if (migrateSubscriptionItem(item)) migrated = true;
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
    return {
      id: item.id,
      provider: item.provider,
      authMethod: item.authMethod || 'api_key',
      oauthStatus: oauthStatusOf(item),
      name: item.name,
      baseUrl: item.baseUrl,
      model: item.model,
      enabled: item.enabled,
      isDefault: item.isDefault,
      createdAt: item.createdAt,
      contextWindow: item.contextWindow || undefined,
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
      apiKeyMasked: maskApiKey(key),
      // 订阅链路无 API Key,凭据是否就绪以 OAuth 登录态(connected)为准。
      apiKeyConfigured:
        item.authMethod === 'oauth_chatgpt'
          ? oauthStatusOf(item)?.status === 'connected'
          : Boolean(key),
    };
  }

  function listProviders() {
    return readAll().map(toView);
  }

  function addProvider({ provider, authMethod, name, baseUrl, model, apiKey, contextWindow, inputPrice, outputPrice, cacheWritePrice, cacheReadPrice, supportsVision, supportsReasoning, supportsPromptCaching }) {
    const items = readAll();
    const defaults = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.openai;
    const method = authMethod === 'oauth_chatgpt' ? 'oauth_chatgpt' : 'api_key';
    // 订阅(OAuth)身份写死:名称/baseURL 固定,不接受外部传入。model 留待登录后选择。
    const isSubscription = method === 'oauth_chatgpt';
    const selectedModel = model || (isSubscription ? DEFAULT_SUBSCRIPTION_MODEL : defaults.model);
    const subscriptionMetadata = isSubscription ? getSubscriptionModelMetadata(selectedModel) : null;
    const item = {
      id: randomUUID(),
      provider: provider || 'openai',
      authMethod: method,
      name: isSubscription ? CHATGPT_SUBSCRIPTION_NAME : name || provider || 'Untitled',
      baseUrl: isSubscription ? CHATGPT_SUBSCRIPTION_BASE_URL : baseUrl || defaults.baseUrl,
      // 订阅默认落到权威清单的最新模型(gpt-5.5),非订阅沿用各家 preset。
      model: selectedModel,
      apiKey: encrypt(isSubscription ? '' : apiKey || ''),
      oauthTokens: encrypt(''),
      enabled: true,
      isDefault: items.length === 0,
      createdAt: new Date().toISOString(),
      contextWindow: isSubscription ? subscriptionMetadata?.contextWindow : (contextWindow || undefined),
      inputPrice: isSubscription ? subscriptionMetadata?.inputPrice : (inputPrice ?? undefined),
      outputPrice: isSubscription ? subscriptionMetadata?.outputPrice : (outputPrice ?? undefined),
      cacheWritePrice: isSubscription ? undefined : (cacheWritePrice ?? undefined),
      cacheReadPrice: isSubscription ? subscriptionMetadata?.cacheReadPrice : (cacheReadPrice ?? undefined),
      longContextInputThreshold: isSubscription ? subscriptionMetadata?.longContextInputThreshold : undefined,
      longContextInputPrice: isSubscription ? subscriptionMetadata?.longContextInputPrice : undefined,
      longContextCacheReadPrice: isSubscription ? subscriptionMetadata?.longContextCacheReadPrice : undefined,
      longContextOutputPrice: isSubscription ? subscriptionMetadata?.longContextOutputPrice : undefined,
      supportsVision: supportsVision ?? false,
      // 订阅链路(codex/responses)原生支持思考强度,默认开启。
      supportsReasoning: isSubscription ? true : (supportsReasoning ?? false),
      supportsPromptCaching: isSubscription ? Boolean(subscriptionMetadata?.cacheReadPrice) : (supportsPromptCaching ?? false),
    };
    items.push(item);
    writeAll(items);
    return toView(item);
  }

  function updateProvider(id, patch) {
    const items = readAll();
    const idx = items.findIndex((i) => i.id === id);
    if (idx < 0) throw new Error(`Provider ${id} not found`);
    const item = items[idx];
    if (patch.provider !== undefined) item.provider = patch.provider;
    if (patch.name !== undefined) item.name = patch.name;
    if (patch.baseUrl !== undefined) item.baseUrl = patch.baseUrl;
    if (patch.model !== undefined) item.model = patch.model;
    if (patch.enabled !== undefined) item.enabled = patch.enabled;
    if (patch.apiKey !== undefined) item.apiKey = encrypt(patch.apiKey);
    if (patch.contextWindow !== undefined) item.contextWindow = patch.contextWindow || undefined;
    if (patch.inputPrice !== undefined) item.inputPrice = patch.inputPrice;
    if (patch.outputPrice !== undefined) item.outputPrice = patch.outputPrice;
    if (patch.cacheWritePrice !== undefined) item.cacheWritePrice = patch.cacheWritePrice;
    if (patch.cacheReadPrice !== undefined) item.cacheReadPrice = patch.cacheReadPrice;
    if (patch.supportsVision !== undefined) item.supportsVision = patch.supportsVision;
    if (patch.supportsReasoning !== undefined) item.supportsReasoning = patch.supportsReasoning;
    if (patch.supportsPromptCaching !== undefined) item.supportsPromptCaching = patch.supportsPromptCaching;
    if (item.authMethod === 'oauth_chatgpt') {
      item.name = CHATGPT_SUBSCRIPTION_NAME;
      item.baseUrl = CHATGPT_SUBSCRIPTION_BASE_URL;
      item.provider = 'openai';
      item.supportsReasoning = true;
      applySubscriptionModelMetadata(item);
    }
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

  function setDefault(id) {
    const items = readAll();
    for (const item of items) {
      item.isDefault = item.id === id;
    }
    writeAll(items);
    return items.map(toView);
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
    return { tokens: decryptTokens(item.oauthTokens) };
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
    if (item.authMethod === 'oauth_chatgpt') {
      return resolveSubscriptionTestResult(oauthStatusOf(item), item.model);
    }

    const apiKey = decrypt(item.apiKey);
    if (!apiKey) return { success: false, error: 'API key not configured' };

    const start = Date.now();
    try {
      if (item.provider === 'anthropic') {
        return await testAnthropic(item.baseUrl, apiKey, item.model, start);
      }
      return await testOpenAI(item.baseUrl, apiKey, item.model, start);
    } catch (err) {
      return { success: false, error: err?.message || 'Connection failed', latencyMs: Date.now() - start };
    }
  }

  return { listProviders, addProvider, updateProvider, removeProvider, setDefault, getDecryptedApiKey, getCredential, setOAuthTokens, testConnection };
}

async function testOpenAI(baseUrl, apiKey, model, start) {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
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

async function testAnthropic(baseUrl, apiKey, model, start) {
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      // 与真实对话路径(anthropic-messages-adapter)共用同一组 CLI 身份头，
      // 否则按客户端身份准入的网关(如 claude-1688-gateway)会对“测试”按钮返回 403。
      ...buildClaudeCliIdentityHeaders(),
    },
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
