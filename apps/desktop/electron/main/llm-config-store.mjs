import electron from 'electron';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import {
  modelApiKeyCredentialKey,
  modelOauthCredentialKey,
} from '@peer-agent/credential-helper';
import { getDataHome, pathOf } from './data-store.mjs';
import { createDesktopModelCredentialClient } from './model-credential-client.mjs';
import { createAccountUsageRevisions } from './account-usage-revision.mjs';
import {
  deriveOAuthStatus,
  enrichTestResultWithDiagnostics,
  resolveSubscriptionTestResult,
} from './provider-connectivity.mjs';
import {
  DEFAULT_SUBSCRIPTION_MODEL,
  SUBSCRIPTION_MODEL_IDS,
  getSubscriptionModelMetadata,
} from './provider-adapters/openai-model-catalog.mjs';
import {
  CHATGPT_SUBSCRIPTION_BASE_URL,
  CHATGPT_SUBSCRIPTION_NAME,
  DEEPSEEK_ANTHROPIC_BASE_URL,
  GEMINI_CODE_ASSIST_BASE_URL,
  GEMINI_OAUTH_NAME,
  QODER_PRIVATE_NAME,
  defaultsForChannel,
  inferChannelId,
  legacyProviderForWire,
  resolveChannel,
  resolveModelCatalogRequestConfig,
  resolveServiceTemplateId,
  validateCustomHeaders,
} from './provider-channels.mjs';
import { loadQoderAccessToken } from './provider-adapters/qoder-local-auth.mjs';
import { getQoderModelMetadata, resolveQoderModelOptionProjection } from './provider-adapters/qoder-model-catalog.mjs';
import {
  fetchModelsDevRegistry,
  fillMissingPricingFromRegistry,
} from './provider-adapters/models-dev-registry.mjs';
import { sendQoderPrivateStream } from './provider-adapters/qoder-private-adapter.mjs';
import { fetchWithConnectionRecovery } from './provider-transports/recovering-fetch.mjs';

const { safeStorage } = electron;

function decryptLegacySecret(stored) {
  if (!stored || !stored.data) return '';
  if (!stored.encrypted) return String(stored.data);
  if (!safeStorage?.isEncryptionAvailable?.()) {
    throw new Error('legacy_safe_storage_unavailable');
  }
  try {
    return safeStorage.decryptString(Buffer.from(stored.data, 'base64'));
  } catch {
    throw new Error('legacy_safe_storage_decrypt_failed');
  }
}

function secretsEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
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

// 为同渠道内复制的模型生成不冲突的 model id：base-copy / base-copy-2 ...
function nextCopyModelId(baseModel, existingModels) {
  const base = String(baseModel || '').trim() || 'model';
  const taken = new Set((existingModels || []).map((m) => String(m || '').trim()).filter(Boolean));
  let candidate = `${base}-copy`;
  if (!taken.has(candidate)) return candidate;
  let n = 2;
  while (taken.has(`${base}-copy-${n}`)) n += 1;
  return `${base}-copy-${n}`;
}


function parseLegacyTokens(stored, decryptSecret = decryptLegacySecret) {
  const raw = decryptSecret(stored);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    throw new Error('legacy_oauth_tokens_invalid');
  }
}

// 仅从非敏感元数据推导列表状态，避免渲染时访问平台安全存储。
function oauthStatusOf(item) {
  if (!isOAuthAuthMethod(item.authMethod)) return undefined;
  if (!item.oauthConfigured) return { status: 'disconnected' };
  return deriveOAuthStatus({
    access: 'configured',
    expires: typeof item.oauthExpires === 'number' ? item.oauthExpires : undefined,
    accountId: item.oauthAccountId,
  });
}

function normalizeModelOptionValues(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const normalized = {};
  for (const [key, optionValue] of Object.entries(value)) {
    if (!key || !['string', 'number', 'boolean'].includes(typeof optionValue)) continue;
    if (typeof optionValue === 'number' && !Number.isFinite(optionValue)) continue;
    normalized[key] = optionValue;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeModelOptions(value) {
  if (!Array.isArray(value)) return undefined;
  const normalized = value.filter((definition) => (
    definition
    && typeof definition === 'object'
    && typeof definition.id === 'string'
    && definition.id.trim()
    && definition.kind === 'select'
    && Array.isArray(definition.choices)
  ));
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeAuthMethod(value) {
  if (value === 'oauth_chatgpt') return 'oauth_chatgpt';
  if (value === 'oauth_google') return 'oauth_google';
  if (value === 'oauth_grok') return 'oauth_grok';
  if (value === 'qoder_local_auth' || value === 'local_cli') return 'qoder_local_auth';
  return 'api_key';
}

function isOAuthAuthMethod(value) {
  return value === 'oauth_chatgpt' || value === 'oauth_google' || value === 'oauth_grok';
}

function isLocalCliAuthMethod(value) {
  return value === 'qoder_local_auth' || value === 'local_cli';
}

function applyQoderModelMetadata(item) {
  const catalogMetadata = getQoderModelMetadata(item.model);
  if (catalogMetadata?.label) item.modelLabel = catalogMetadata.label;
  const metadata = catalogMetadata || {
    contextWindow: item.contextWindow,
    modelOptions: item.modelOptions,
    supportsReasoning: item.supportsReasoning,
    reasoningEffortLevels: item.reasoningEffortLevels,
    reasoningDefaultEffort: item.reasoningDefaultEffort,
  };
  // 与发送链路同口径：按 contextTier 档位投影后的可用输入窗口（1M 档 − 输出预留），
  // 而非目录原始窗口。历史模型不在实时目录时，继续使用持久化的 modelOptions，
  // 避免已选择的档位退回旧 contextWindow。
  const optionProjection = resolveQoderModelOptionProjection(metadata, item.modelOptionValues);
  item.contextWindow = optionProjection?.inputTokenLimit
    ?? metadata?.contextWindow
    ?? item.contextWindow;
  item.maxOutputTokens = metadata?.maxOutputTokens ?? item.maxOutputTokens;
  if (Array.isArray(metadata?.modelOptions) && metadata.modelOptions.length) {
    item.modelOptions = metadata.modelOptions;
  }
  if (typeof metadata?.supportsVision === 'boolean') item.supportsVision = metadata.supportsVision;
  // thinking_config 投影优先：有 reasoningEffortLevels 即支持思考（性能档 is_reasoning=false 也要开）。
  if (Array.isArray(metadata?.reasoningEffortLevels) && metadata.reasoningEffortLevels.length) {
    item.supportsReasoning = true;
    item.reasoningEffortLevels = [...metadata.reasoningEffortLevels];
    if (metadata.reasoningDefaultEffort) {
      item.reasoningDefaultEffort = metadata.reasoningDefaultEffort;
    }
  } else if (typeof metadata?.supportsReasoning === 'boolean') {
    item.supportsReasoning = metadata.supportsReasoning;
  }
  // Qoder's catalog does not currently declare prompt-cache support. Keep that
  // capability unknown instead of turning missing metadata into an explicit no.
  delete item.supportsPromptCaching;
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
  if (patch.metadataSource !== undefined) {
    const source = String(patch.metadataSource || '').trim();
    if (['remote', 'models.dev', 'builtin', 'local', 'manual'].includes(source)) item.metadataSource = source;
    else delete item.metadataSource;
  }
  if (patch.pricingSource !== undefined) {
    const source = String(patch.pricingSource || '').trim();
    if (['provider', 'models.dev-reference'].includes(source)) item.pricingSource = source;
    else delete item.pricingSource;
  }
  if (patch.metadataSyncedAt !== undefined) {
    const syncedAt = String(patch.metadataSyncedAt || '').trim();
    if (syncedAt) item.metadataSyncedAt = syncedAt;
    else delete item.metadataSyncedAt;
  }
  const optionalFields = [
    'contextWindow',
    'maxOutputTokens',
    'inputPrice',
    'outputPrice',
    'cacheWritePrice',
    'cacheReadPrice',
    'reasoningParamStyle',
    'reasoningEffortMap',
    'supportsPromptCaching',
    'supportsVision',
    'supportsReasoning',
  ];
  for (const field of optionalFields) {
    if (patch[field] === undefined) continue;
    if (patch[field] === null || patch[field] === '') delete item[field];
    else item[field] = patch[field];
  }
}

export function createLlmConfigStore({
  configFile = pathOf('llmProviders'),
  credentialClient: providedCredentialClient,
  credentialDataHome,
  legacySecretDecryptor = decryptLegacySecret,
  providerFetch = fetchWithConnectionRecovery,
} = {}) {
  let productionCredentialClient;
  const accountUsageRevisions = createAccountUsageRevisions();
  function credentials() {
    if (providedCredentialClient) return providedCredentialClient;
    productionCredentialClient ??= createDesktopModelCredentialClient({
      dataHome: credentialDataHome || getDataHome(),
    });
    return productionCredentialClient;
  }

  function groupKey(item) {
    return String(item?.groupId || item?.id || '').trim();
  }

  function readApiKey(item) {
    const key = groupKey(item);
    return key ? credentials().getSecret(modelApiKeyCredentialKey(key)) || '' : '';
  }

  function readOAuthTokens(item) {
    const key = groupKey(item);
    if (!key) return null;
    const raw = credentials().getSecret(modelOauthCredentialKey(key));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      throw new Error('credential_oauth_tokens_invalid');
    }
  }

  function writeVerifiedSecret(key, secret) {
    if (!secret) {
      credentials().deleteSecret(key);
      if (credentials().getSecret(key) !== null) {
        throw new Error('credential_delete_verify_failed');
      }
      return;
    }
    credentials().setSecret(key, secret);
    const verify = credentials().getSecret(key);
    if (!secretsEqual(secret, verify)) throw new Error('credential_migration_verify_failed');
  }

  function setGroupApiKey(groupId, value) {
    writeVerifiedSecret(modelApiKeyCredentialKey(groupId), String(value || ''));
  }

  function setGroupOAuthTokens(groupId, tokens) {
    const serialized = tokens ? JSON.stringify(tokens) : '';
    writeVerifiedSecret(modelOauthCredentialKey(groupId), serialized);
  }

  function removeGroupSecrets(groupId) {
    if (!groupId) return;
    writeVerifiedSecret(modelApiKeyCredentialKey(groupId), '');
    writeVerifiedSecret(modelOauthCredentialKey(groupId), '');
  }

  function syncGroupSecretMetadata(items, groupId, metadata) {
    for (const item of items) {
      if (groupKey(item) !== groupId) continue;
      Object.assign(item, metadata);
    }
  }

  function snapshotGroupSecrets(groupId) {
    return {
      apiKey: credentials().getSecret(modelApiKeyCredentialKey(groupId)),
      oauthTokens: credentials().getSecret(modelOauthCredentialKey(groupId)),
    };
  }

  function restoreGroupSecrets(groupId, snapshot) {
    writeVerifiedSecret(modelApiKeyCredentialKey(groupId), snapshot.apiKey || '');
    writeVerifiedSecret(modelOauthCredentialKey(groupId), snapshot.oauthTokens || '');
  }

  function withGroupSecretTransaction(groupId, mutateSecrets, writeMetadata) {
    const snapshot = snapshotGroupSecrets(groupId);
    try {
      mutateSecrets();
      const next = snapshotGroupSecrets(groupId);
      if (snapshot.apiKey !== next.apiKey || snapshot.oauthTokens !== next.oauthTokens) accountUsageRevisions.invalidate(groupId);
      return writeMetadata();
    } catch (error) {
      try {
        restoreGroupSecrets(groupId, snapshot);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'credential_transaction_rollback_failed',
        );
      }
      throw error;
    }
  }

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
    // 缓存能力是模型能力，不等于“缓存读取价是否为 truthy”。显式能力优先；旧目录没有
    // capability 字段时，只要声明过 cached-input 价格（包括 0）也视为支持。
    const supportsPromptCaching = metadata.supportsPromptCaching
      ?? metadata.cacheReadPrice !== undefined;
    if (item.supportsPromptCaching !== supportsPromptCaching) {
      item.supportsPromptCaching = supportsPromptCaching;
      changed = true;
    }
    if (metadata.supportsVision !== undefined && item.supportsVision !== metadata.supportsVision) {
      item.supportsVision = metadata.supportsVision;
      changed = true;
    }
    if (metadata.supportsReasoning !== undefined && item.supportsReasoning !== metadata.supportsReasoning) {
      item.supportsReasoning = metadata.supportsReasoning;
      changed = true;
    }
    const effortLevels = Array.isArray(metadata.reasoningEffortLevels)
      ? metadata.reasoningEffortLevels
      : null;
    if (effortLevels) {
      const sameLevels = Array.isArray(item.reasoningEffortLevels)
        && item.reasoningEffortLevels.length === effortLevels.length
        && item.reasoningEffortLevels.every((level, index) => level === effortLevels[index]);
      if (!sameLevels) {
        item.reasoningEffortLevels = [...effortLevels];
        changed = true;
      }
    } else if (item.reasoningEffortLevels !== undefined) {
      // 切到没有模型级覆盖的订阅模型时，删除旧模型遗留值；toView 会回退到 channel 能力。
      delete item.reasoningEffortLevels;
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
      if (item.name !== GEMINI_OAUTH_NAME) {
        item.name = GEMINI_OAUTH_NAME;
        changed = true;
      }
      if (item.channelId !== 'google-ai') {
        item.channelId = 'google-ai';
        changed = true;
      }
      if (item.baseUrl !== GEMINI_CODE_ASSIST_BASE_URL) {
        item.baseUrl = GEMINI_CODE_ASSIST_BASE_URL;
        changed = true;
      }
      if (item.wireOverride !== undefined) {
        delete item.wireOverride;
        changed = true;
      }
    }
    if (item.authMethod === 'oauth_grok') {
      if (item.name !== 'Grok 官方') {
        item.name = 'Grok 官方';
        changed = true;
      }
      if (item.channelId !== 'grok') {
        item.channelId = 'grok';
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
      if (item.apiKey !== undefined) {
        delete item.apiKey;
        item.apiKeyConfigured = false;
        delete item.apiKeyMasked;
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
    // DeepSeek 官方改走 Anthropic 兼容入口：旧 openai-chat + api.deepseek.com
    // 必须迁到 anthropic-messages + api.deepseek.com/anthropic，否则思考强度契约不生效。
    // 模型侧可能仍持久化旧档位 off/default（UI 会优先读模型字段，导致滑条仍只有“标准思考”）。
    if (item.channelId === 'deepseek') {
      const baseUrl = String(item.baseUrl || '').replace(/\/+$/, '');
      const isLegacyDeepSeekOpenAI =
        !baseUrl
        || baseUrl === 'https://api.deepseek.com'
        || baseUrl === 'https://api.deepseek.com/v1';
      if (isLegacyDeepSeekOpenAI && baseUrl !== DEEPSEEK_ANTHROPIC_BASE_URL) {
        item.baseUrl = DEEPSEEK_ANTHROPIC_BASE_URL;
        changed = true;
      }
      if (item.wireOverride === 'openai-chat' || item.wireOverride === 'openai-responses') {
        delete item.wireOverride;
        changed = true;
      }
      if (item.provider === 'openai') {
        item.provider = 'anthropic';
        changed = true;
      }
      // 渠道能力真源：off/low/high/max（默认 high）。覆盖历史 off/default 与空值。
      const targetLevels = ['off', 'low', 'high', 'max'];
      const currentLevels = Array.isArray(item.reasoningEffortLevels)
        ? item.reasoningEffortLevels
        : null;
      const levelsStale = !currentLevels
        || currentLevels.length !== targetLevels.length
        || currentLevels.some((level, index) => level !== targetLevels[index]);
      if (levelsStale) {
        item.reasoningEffortLevels = [...targetLevels];
        changed = true;
      }
      if (item.reasoningDefaultEffort !== 'high') {
        item.reasoningDefaultEffort = 'high';
        changed = true;
      }
      if (item.supportsReasoning !== true) {
        item.supportsReasoning = true;
        changed = true;
      }
      if (item.reasoningParamStyle !== 'anthropic-enabled-output-effort') {
        item.reasoningParamStyle = 'anthropic-enabled-output-effort';
        changed = true;
      }
    }
    // Kimi Coding Plan / Moonshot：旧配置可能仍是 off/default + paramStyle none，
    // UI 优先读模型持久化字段会导致滑条只有“标准思考”。强制对齐官方 K3 多档。
    if (item.channelId === 'kimi-coding-plan' || item.channelId === 'moonshot') {
      const targetLevels = ['off', 'low', 'default', 'max'];
      const currentLevels = Array.isArray(item.reasoningEffortLevels)
        ? item.reasoningEffortLevels
        : null;
      const levelsStale = !currentLevels
        || currentLevels.length !== targetLevels.length
        || currentLevels.some((level, index) => level !== targetLevels[index]);
      if (levelsStale) {
        item.reasoningEffortLevels = [...targetLevels];
        changed = true;
      }
      if (item.reasoningDefaultEffort !== 'default') {
        item.reasoningDefaultEffort = 'default';
        changed = true;
      }
      if (item.supportsReasoning !== true) {
        item.supportsReasoning = true;
        changed = true;
      }
      if (item.reasoningParamStyle !== 'openai-effort') {
        item.reasoningParamStyle = 'openai-effort';
        changed = true;
      }
    }
    // Grok 官方：旧配置可能仍是 4.5 时代的 low/medium/high。
    // UI 优先读模型持久化字段，会把渠道新声明的 xhigh 挡住。
    if (item.channelId === 'grok') {
      const targetLevels = ['low', 'medium', 'high', 'xhigh'];
      const currentLevels = Array.isArray(item.reasoningEffortLevels)
        ? item.reasoningEffortLevels
        : null;
      const levelsStale = !currentLevels
        || currentLevels.length !== targetLevels.length
        || currentLevels.some((level, index) => level !== targetLevels[index]);
      if (levelsStale) {
        item.reasoningEffortLevels = [...targetLevels];
        changed = true;
      }
      if (item.reasoningDefaultEffort !== 'high') {
        item.reasoningDefaultEffort = 'high';
        changed = true;
      }
      if (item.supportsReasoning !== true) {
        item.supportsReasoning = true;
        changed = true;
      }
      if (item.reasoningParamStyle !== 'openai-effort') {
        item.reasoningParamStyle = 'openai-effort';
        changed = true;
      }
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

  function mergeLegacySecret(group, field, value) {
    if (group[`${field}Present`]) {
      const current = field === 'oauthTokens'
        ? JSON.stringify(group[field] || null)
        : String(group[field] || '');
      const incoming = field === 'oauthTokens'
        ? JSON.stringify(value || null)
        : String(value || '');
      if (!secretsEqual(current, incoming)) {
        throw new Error(`legacy_credential_conflict:${group.groupId}:${field}`);
      }
      return;
    }
    group[`${field}Present`] = true;
    group[field] = value;
  }

  function rollbackCredentialSnapshots(snapshots, cause) {
    const rollbackErrors = [];
    for (const [groupId, snapshot] of snapshots) {
      try {
        restoreGroupSecrets(groupId, snapshot);
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [cause, ...rollbackErrors],
        'credential_migration_rollback_failed',
      );
    }
    throw cause;
  }

  function migrateLegacyCredentials(items) {
    const groups = new Map();
    for (const item of items) {
      const hasLegacySecret = item.apiKey !== undefined
        || item.oauthTokens !== undefined;
      if (!hasLegacySecret) continue;
      const groupId = groupKey(item);
      if (!groupId) throw new Error('legacy_credential_group_missing');
      const group = groups.get(groupId) || { groupId };
      if (item.apiKey !== undefined) {
        mergeLegacySecret(group, 'apiKey', legacySecretDecryptor(item.apiKey));
      }
      if (item.oauthTokens !== undefined) {
        mergeLegacySecret(
          group,
          'oauthTokens',
          parseLegacyTokens(item.oauthTokens, legacySecretDecryptor),
        );
      }
      groups.set(groupId, group);
    }
    if (groups.size === 0) return null;

    const snapshots = new Map();
    for (const group of groups.values()) {
      snapshots.set(group.groupId, snapshotGroupSecrets(group.groupId));
    }
    try {
      for (const group of groups.values()) {
        if (group.apiKeyPresent) setGroupApiKey(group.groupId, group.apiKey);
        if (group.oauthTokensPresent) setGroupOAuthTokens(group.groupId, group.oauthTokens);
      }
    } catch (error) {
      rollbackCredentialSnapshots(snapshots, error);
    }

    for (const item of items) {
      const group = groups.get(groupKey(item));
      if (!group) continue;
      if (group.apiKeyPresent) {
        item.apiKeyConfigured = Boolean(group.apiKey);
        if (group.apiKey) item.apiKeyMasked = maskApiKey(group.apiKey);
        else delete item.apiKeyMasked;
      }
      if (group.oauthTokensPresent) {
        const tokens = group.oauthTokens;
        item.oauthConfigured = Boolean(tokens?.access);
        if (typeof tokens?.expires === 'number') item.oauthExpires = tokens.expires;
        else delete item.oauthExpires;
        if (tokens?.accountId) item.oauthAccountId = String(tokens.accountId);
        else delete item.oauthAccountId;
      }
      delete item.apiKey;
      delete item.oauthTokens;
    }
    return snapshots;
  }

  function channelFromItem(item) {
    const channel = { ...item, id: groupKey(item) };
    for (const field of [
      'model', 'modelLabel', 'metadataSource', 'pricingSource', 'metadataSyncedAt',
      'contextWindow', 'maxOutputTokens', 'modelOptions', 'modelOptionValues',
      'inputPrice', 'outputPrice', 'cacheWritePrice', 'cacheReadPrice',
      'longContextInputThreshold', 'longContextInputPrice', 'longContextCacheReadPrice',
      'longContextOutputPrice', 'supportsVision', 'supportsReasoning',
      'supportsPromptCaching', 'reasoningParamStyle', 'reasoningEffortMap',
      'reasoningEffortLevels', 'enabled', 'isDefault',
    ]) delete channel[field];
    for (const field of [
      'apiKey', 'oauthTokens', 'oauthClientId', 'oauthClientSecret',
      'oauthClientSecretConfigured',
    ]) delete channel[field];
    channel.groupId = channel.id;
    return channel;
  }

  function readStoredState() {
    if (!existsSync(configFile)) return { channels: [], models: [], legacy: false };
    try {
      const parsed = JSON.parse(readFileSync(configFile, 'utf8'));
      if (Array.isArray(parsed)) {
        const channels = [...new Map(parsed.map((item) => [groupKey(item), channelFromItem(item)])).values()];
        return { channels, models: parsed, legacy: true };
      }
      if (parsed && Array.isArray(parsed.channels) && Array.isArray(parsed.models)) {
        return { channels: parsed.channels, models: parsed.models, legacy: false };
      }
    } catch {
      // Invalid configuration is treated as empty, matching the legacy behavior.
    }
    return { channels: [], models: [], legacy: false };
  }

  function readAll() {
    const state = readStoredState();
    const channels = new Map(state.channels.map((channel) => [channel.id || channel.groupId, channel]));
    const parsed = state.models.map((model) => {
      const channel = channels.get(groupKey(model));
      return channel ? { ...channel, ...model, groupId: channel.id || channel.groupId } : model;
    });
    let migrated = state.legacy;
    for (const item of parsed) {
      if (migrateChannelItem(item)) migrated = true;
      if (migrateSubscriptionItem(item)) migrated = true;
      if (migrateGroupId(item)) migrated = true;
      if (Object.hasOwn(item, 'oauthClientId')) {
        delete item.oauthClientId;
        migrated = true;
      }
      if (Object.hasOwn(item, 'oauthClientSecret')) {
        delete item.oauthClientSecret;
        migrated = true;
      }
      if (Object.hasOwn(item, 'oauthClientSecretConfigured')) {
        delete item.oauthClientSecretConfigured;
        migrated = true;
      }
    }
    const credentialSnapshots = migrateLegacyCredentials(parsed);
    if (credentialSnapshots) migrated = true;
    if (migrated) {
      try {
        writeAll(parsed);
      } catch (error) {
        if (credentialSnapshots) rollbackCredentialSnapshots(credentialSnapshots, error);
        throw error;
      }
    }
    return parsed;
  }

  function writeAll(items, channelsOverride) {
    const previous = readStoredState();
    const channels = new Map(
      (channelsOverride || previous.channels).map((channel) => [channel.id || channel.groupId, channel]),
    );
    for (const item of items) {
      const groupId = groupKey(item);
      const existing = channels.get(groupId);
      channels.set(groupId, { ...(existing || {}), ...channelFromItem(item), id: groupId, groupId });
    }
    const models = items.map((item) => {
      const model = { ...item };
      const channel = channels.get(groupKey(item));
      for (const field of Object.keys(channel || {})) {
        if (!['id', 'groupId'].includes(field)) delete model[field];
      }
      model.id = item.id;
      model.groupId = groupKey(item);
      return model;
    });
    const stored = { version: 2, channels: [...channels.values()], models };
    const directory = path.dirname(configFile);
    mkdirSync(directory, { recursive: true });
    const temporaryFile = path.join(
      directory,
      `.${path.basename(configFile)}.${process.pid}.${randomUUID()}.tmp`,
    );
    let descriptor;
    try {
      descriptor = openSync(temporaryFile, 'wx', 0o600);
      writeFileSync(descriptor, JSON.stringify(stored, null, 2), 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporaryFile, configFile);
    } catch (error) {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch { /* best effort */ }
      }
      try { unlinkSync(temporaryFile); } catch { /* best effort */ }
      throw error;
    }
  }

  function toView(item) {
    const oauthStatus = oauthStatusOf(item);
    const resolved = (() => {
      try {
        // 模型目录/元数据源(如 models.dev/remote)常把 supportsPromptCaching 落成 null。
        // 若直接透传给 resolveChannel，其 `!== undefined` 分支会把 null 当「禁用缓存」
        // (Boolean(null)=false)，覆盖渠道 descriptor 的 promptCache: true。
        // 这里把 null/undefined 视为「未声明」，仅在显式 true/false 时透传，
        // 让渠道能力(如 DeepSeek promptCache: true)正确倒档。
        const resolveInput = { ...item };
        if (resolveInput.supportsPromptCaching == null) delete resolveInput.supportsPromptCaching;
        return resolveChannel({
          ...resolveInput,
          apiKey: item.apiKeyConfigured || item.oauthConfigured ? 'configured' : '',
          accountId: oauthStatus?.accountId,
        });
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
      oauthStatus,
      accountUsageRevision: accountUsageRevisions.revision(item),
      name: item.name,
      baseUrl: item.baseUrl,
      model: item.model,
      modelLabel: item.modelLabel || undefined,
      metadataSource: item.metadataSource || undefined,
      pricingSource: item.pricingSource || undefined,
      metadataSyncedAt: item.metadataSyncedAt || undefined,
      enabled: item.enabled,
      isDefault: item.isDefault,
      createdAt: item.createdAt,
      contextWindow: item.contextWindow || undefined,
      maxOutputTokens: item.maxOutputTokens || undefined,
      modelOptions: normalizeModelOptions(item.modelOptions),
      modelOptionValues: normalizeModelOptionValues(item.modelOptionValues),
      inputPrice: item.inputPrice ?? undefined,
      outputPrice: item.outputPrice ?? undefined,
      cacheWritePrice: item.cacheWritePrice ?? undefined,
      cacheReadPrice: item.cacheReadPrice ?? undefined,
      longContextInputThreshold: item.longContextInputThreshold ?? undefined,
      longContextInputPrice: item.longContextInputPrice ?? undefined,
      longContextCacheReadPrice: item.longContextCacheReadPrice ?? undefined,
      longContextOutputPrice: item.longContextOutputPrice ?? undefined,
      supportsVision: item.supportsVision ?? undefined,
      supportsReasoning: item.supportsReasoning ?? undefined,
      // 缓存能力回填：模型条目未显式声明时，仅在渠道能力为 true 时回填为 true。
      // 模型目录(如 models.dev/remote)通常不带 supportsPromptCaching 字段，
      // 若直接透传 null/undefined，渲染层门控(supportsPromptCaching === true)会失守。
      // 渠道声明(如 DeepSeek promptCache: true)在此作为权威回退；
      // 但渠道明确不支持缓存(如 Qoder promptCache: false)或不可解析时保持 undefined，
      // 避免把「无缓存语义」误判成「禁用缓存」。
      supportsPromptCaching: item.supportsPromptCaching ?? (resolved?.supportsPromptCaching === true ? true : undefined),
      // DeepSeek / Kimi / Grok：渠道级思考契约优先于模型历史缓存。
      // 避免旧档位（DeepSeek off/default、Grok 三档）盖住渠道新声明。
      // 其他渠道保持原语义：模型字段优先，缺失时再回落渠道档位；paramStyle 不静默回落渠道。
      reasoningParamStyle: (
        item.channelId === 'deepseek'
        || item.channelId === 'kimi-coding-plan'
        || item.channelId === 'moonshot'
        || item.channelId === 'grok'
      )
        ? (resolved?.reasoningParamStyle ?? item.reasoningParamStyle ?? undefined)
        : (item.reasoningParamStyle ?? undefined),
      reasoningEffortMap: (
        item.channelId === 'deepseek'
        || item.channelId === 'kimi-coding-plan'
        || item.channelId === 'moonshot'
        || item.channelId === 'grok'
      )
        ? (resolved?.reasoningEffortMap ?? item.reasoningEffortMap ?? undefined)
        : (item.reasoningEffortMap ?? undefined),
      reasoningEffortLevels: (
        item.channelId === 'deepseek'
        || item.channelId === 'kimi-coding-plan'
        || item.channelId === 'moonshot'
        || item.channelId === 'grok'
          ? (resolved?.reasoningEffortLevels ?? item.reasoningEffortLevels)
          : (item.reasoningEffortLevels ?? resolved?.reasoningEffortLevels)
      ) ?? undefined,
      reasoningDefaultEffort: (
        item.channelId === 'deepseek'
        || item.channelId === 'kimi-coding-plan'
        || item.channelId === 'moonshot'
        || item.channelId === 'grok'
          ? (resolved?.reasoningDefaultEffort ?? item.reasoningDefaultEffort)
          : (item.reasoningDefaultEffort ?? resolved?.reasoningDefaultEffort)
      ) ?? undefined,
      oauthProjectId: item.oauthProjectId ?? undefined,
      customHeaders: item.customHeaders ?? undefined,
      customHeadersInvalid: item.customHeadersInvalid ?? undefined,
      serviceTemplateId:
        item.serviceTemplateId
        || resolveServiceTemplateId({
          channelId: item.channelId || inferChannelId(item),
          authMethod: item.authMethod || 'api_key',
        })
        || undefined,
      connectionState: item.connectionState || undefined,
      connectionStateReason: item.connectionStateReason || undefined,
      configVersion: item.configVersion || undefined,
      lastCheckedAt: item.lastCheckedAt || undefined,
      lastSuccessAt: item.lastSuccessAt || undefined,
      lastErrorCategory: item.lastErrorCategory || undefined,
      lastDiagnostic: item.lastDiagnostic || undefined,
      apiKeyMasked: item.apiKeyMasked || '',
      // 订阅链路无 API Key,凭据是否就绪以 OAuth 登录态(connected)为准；
      // 本机 CLI 链路的登录态由外部应用维护,Peer Agent 只检查命令与登录态是否可用。
      apiKeyConfigured:
        isLocalCliAuthMethod(item.authMethod)
          ? true
          : isOAuthAuthMethod(item.authMethod)
          ? oauthStatus?.status === 'connected'
          : Boolean(item.apiKeyConfigured),
    };
  }

  function listProviders() {
    return readAll().map(toView);
  }

  function listGroups() {
    const state = readStoredState();
    const models = readAll();
    const modelsByGroup = new Map();
    for (const model of models) {
      const groupId = groupKey(model);
      const groupModels = modelsByGroup.get(groupId) || [];
      groupModels.push(model);
      modelsByGroup.set(groupId, groupModels);
    }
    return state.channels.flatMap((channel) => {
      const groupId = channel.id || channel.groupId;
      const groupModels = modelsByGroup.get(groupId) || [];
      if (groupModels.length > 0) return groupModels.map(toView);
      const representative = {
        ...channel,
        id: groupId,
        groupId,
        model: '',
        enabled: false,
        isDefault: false,
        createdAt: channel.createdAt || new Date().toISOString(),
      };
      return [{ ...toView(representative), id: groupId, groupId, model: '' }];
    });
  }

  // 兼容旧 IPC 名称，但返回的仍是已配置模型真值。模型目录只在设置页作为候选来源，
  // 不再在聊天/路由层虚拟展开，否则持久化多模型会与目录形成 N×M 笛卡尔积。
  function listChatProviders() {
    return listProviders();
  }

  function addProvider({ provider, groupId: rawGroupId, channelId: rawChannelId, wireOverride, authMethod, name, baseUrl, model, modelLabel, metadataSource, pricingSource, metadataSyncedAt, apiKey, contextWindow, maxOutputTokens, modelOptions, modelOptionValues, inputPrice, outputPrice, cacheWritePrice, cacheReadPrice, supportsVision, supportsReasoning, supportsPromptCaching, reasoningParamStyle, reasoningEffortMap, oauthProjectId, customHeaders, serviceTemplateId }) {
    const items = readAll();
    const method = normalizeAuthMethod(authMethod);
    const channelId = method === 'oauth_chatgpt'
      ? 'openai'
      : method === 'oauth_google'
        ? 'google-ai'
        : method === 'oauth_grok'
          ? 'grok'
          : method === 'qoder_local_auth'
            ? 'qoder'
            : (rawChannelId || inferChannelId({ provider, authMethod: method }));
    const defaults = rawChannelId ? defaultsForChannel(channelId) : (PROVIDER_DEFAULTS[provider] || defaultsForChannel(channelId));
    if (customHeaders) validateCustomHeaders(customHeaders);
    // 订阅(OAuth)身份写死:名称/baseURL 固定,不接受外部传入。model 留待登录后选择。
    const isSubscription = method === 'oauth_chatgpt';
    const isGoogleOAuth = method === 'oauth_google';
    const isGrokOAuth = method === 'oauth_grok';
    const isLocalQoderAuth = method === 'qoder_local_auth';
    const selectedModel = model || (isSubscription ? DEFAULT_SUBSCRIPTION_MODEL : defaults.model);
    const subscriptionMetadata = isSubscription ? getSubscriptionModelMetadata(selectedModel) : null;
    const resolved = resolveChannel({
      channelId,
      wireOverride,
      authMethod: method,
      baseUrl: isSubscription ? CHATGPT_SUBSCRIPTION_BASE_URL : (isLocalQoderAuth ? defaults.baseUrl : (baseUrl || defaults.baseUrl)),
      apiKey: isSubscription || isGoogleOAuth || isGrokOAuth || isLocalQoderAuth ? '' : (apiKey || ''),
      supportsReasoning: isSubscription ? true : (isLocalQoderAuth ? false : supportsReasoning),
      supportsPromptCaching: isSubscription
        ? (subscriptionMetadata?.supportsPromptCaching ?? subscriptionMetadata?.cacheReadPrice !== undefined)
        : (isLocalQoderAuth ? false : supportsPromptCaching),
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
      wireOverride: isSubscription || isGoogleOAuth || isGrokOAuth || isLocalQoderAuth ? undefined : wireOverride,
      authMethod: method,
      serviceTemplateId: serviceTemplateId
        || resolveServiceTemplateId({ channelId, authMethod: method })
        || undefined,
      configVersion: 1,
      connectionState: 'pending_verification',
      name: isSubscription ? CHATGPT_SUBSCRIPTION_NAME : isGoogleOAuth ? GEMINI_OAUTH_NAME : isGrokOAuth ? (name || 'Grok 官方') : isLocalQoderAuth ? (name || QODER_PRIVATE_NAME) : name || provider || 'Untitled',
      baseUrl: isSubscription ? CHATGPT_SUBSCRIPTION_BASE_URL : isGoogleOAuth ? GEMINI_CODE_ASSIST_BASE_URL : isLocalQoderAuth ? defaults.baseUrl : baseUrl || defaults.baseUrl,
      // 订阅默认落到权威清单的最新模型(gpt-5.5),非订阅沿用各家 preset。
      model: selectedModel,
      modelLabel: modelLabel || undefined,
      metadataSource: isSubscription ? 'builtin' : isLocalQoderAuth ? 'local' : metadataSource,
      pricingSource: isSubscription || isLocalQoderAuth ? undefined : pricingSource,
      metadataSyncedAt: isSubscription || isLocalQoderAuth ? new Date().toISOString() : metadataSyncedAt,
      apiKeyConfigured: false,
      oauthProjectId: isGoogleOAuth ? String(oauthProjectId || '').trim() || undefined : undefined,
      oauthConfigured: false,
      enabled: true,
      isDefault: items.length === 0,
      createdAt: new Date().toISOString(),
      contextWindow: isSubscription ? subscriptionMetadata?.contextWindow : (contextWindow || undefined),
      maxOutputTokens: isSubscription ? subscriptionMetadata?.maxOutputTokens : (maxOutputTokens || undefined),
      modelOptions: normalizeModelOptions(modelOptions),
      modelOptionValues: normalizeModelOptionValues(modelOptionValues),
      inputPrice: isSubscription ? subscriptionMetadata?.inputPrice : (inputPrice ?? undefined),
      outputPrice: isSubscription ? subscriptionMetadata?.outputPrice : (outputPrice ?? undefined),
      cacheWritePrice: isSubscription || isLocalQoderAuth ? undefined : (cacheWritePrice ?? undefined),
      cacheReadPrice: isSubscription ? subscriptionMetadata?.cacheReadPrice : (cacheReadPrice ?? undefined),
      longContextInputThreshold: isSubscription ? subscriptionMetadata?.longContextInputThreshold : undefined,
      longContextInputPrice: isSubscription ? subscriptionMetadata?.longContextInputPrice : undefined,
      longContextCacheReadPrice: isSubscription ? subscriptionMetadata?.longContextCacheReadPrice : undefined,
      longContextOutputPrice: isSubscription ? subscriptionMetadata?.longContextOutputPrice : undefined,
      supportsVision: isSubscription
        ? subscriptionMetadata?.supportsVision
        : (isLocalQoderAuth ? undefined : supportsVision),
      // 订阅链路(codex/responses)原生支持思考强度,默认开启。
      // Qoder 本地鉴权由 applyQoderModelMetadata 按 thinking_config 投影，不在这里写死 false。
      supportsReasoning: isSubscription
        ? (subscriptionMetadata?.supportsReasoning ?? true)
        : (isLocalQoderAuth ? undefined : supportsReasoning),
      supportsPromptCaching: isSubscription
        ? (subscriptionMetadata?.supportsPromptCaching ?? subscriptionMetadata?.cacheReadPrice !== undefined)
        : (isLocalQoderAuth ? undefined : supportsPromptCaching),
      reasoningParamStyle: reasoningParamStyle || undefined,
      reasoningEffortMap: resolved.reasoningEffortMap || undefined,
      reasoningEffortLevels: subscriptionMetadata?.reasoningEffortLevels
        ? [...subscriptionMetadata.reasoningEffortLevels]
        : resolved.reasoningEffortLevels || undefined,
      reasoningDefaultEffort: resolved.reasoningDefaultEffort || undefined,
      customHeaders: customHeaders || undefined,
    };
    if (isLocalQoderAuth) applyQoderModelMetadata(item);
    item.provider = legacyProviderForWire(resolved.wire);

    const existingGroup = items.find((candidate) => groupKey(candidate) === item.groupId);
    if (existingGroup) {
      item.apiKeyConfigured = Boolean(existingGroup.apiKeyConfigured);
      item.apiKeyMasked = existingGroup.apiKeyMasked || undefined;
      item.oauthConfigured = Boolean(existingGroup.oauthConfigured);
      item.oauthExpires = existingGroup.oauthExpires;
      item.oauthAccountId = existingGroup.oauthAccountId;
      items.push(item);
      writeAll(items);
      return toView(item);
    }

    const storedApiKey = isOAuthAuthMethod(method) || isLocalQoderAuth ? '' : String(apiKey || '');
    item.apiKeyConfigured = Boolean(storedApiKey);
    item.apiKeyMasked = storedApiKey ? maskApiKey(storedApiKey) : undefined;
    items.push(item);
    return withGroupSecretTransaction(
      item.groupId,
      () => {
        setGroupApiKey(item.groupId, storedApiKey);
      },
      () => {
        writeAll(items);
        return toView(item);
      },
    );
  }

  function updateProvider(id, patch) {
    const items = readAll();
    const idx = items.findIndex((i) => i.id === id);
    if (idx < 0) throw new Error(`Provider ${id} not found`);
    const item = items[idx];
    const groupId = groupKey(item);
    const previousAuthMethod = normalizeAuthMethod(item.authMethod);
    if (patch.authMethod !== undefined) item.authMethod = normalizeAuthMethod(patch.authMethod);
    const leavingOAuth = isOAuthAuthMethod(previousAuthMethod) && !isOAuthAuthMethod(item.authMethod);
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
      const nextModel = String(patch.model || '').trim();
      if (!nextModel) throw new Error('model is required');
      // 同渠道内 model id 必须唯一；允许保留自身当前值。
      if (items.some((other) => other.id !== id
        && (other.groupId || other.id) === groupId
        && String(other.model || '').trim() === nextModel)) {
        throw new Error(`Model ${nextModel} already exists in provider group`);
      }
      item.model = nextModel;
      // 改 model 后默认清掉旧昵称；若本次 patch 同时带 modelLabel，随后会写回。
      delete item.modelLabel;
    }
    applyExplicitModelMetadataPatch(item, patch);
    if (patch.modelOptions !== undefined) item.modelOptions = normalizeModelOptions(patch.modelOptions);
    if (patch.modelOptionValues !== undefined) item.modelOptionValues = normalizeModelOptionValues(patch.modelOptionValues);
    if (patch.enabled !== undefined) item.enabled = patch.enabled;
    if (patch.apiKey !== undefined) {
      syncGroupSecretMetadata(items, groupId, {
        apiKeyConfigured: Boolean(patch.apiKey),
        apiKeyMasked: patch.apiKey ? maskApiKey(patch.apiKey) : undefined,
      });
    }
    if (patch.oauthProjectId !== undefined) {
      const nextProjectId = String(patch.oauthProjectId || '').trim() || undefined;
      item.oauthProjectId = nextProjectId;
      // project 是 group 级元数据：同步到同 group 全部 model，并在 writeAll 时写入 channel。
      syncGroupSecretMetadata(items, groupId, { oauthProjectId: nextProjectId });
    }
    if (patch.customHeaders !== undefined) {
      validateCustomHeaders(patch.customHeaders || {});
      item.customHeaders = patch.customHeaders || undefined;
      delete item.customHeadersInvalid;
    }
    if (leavingOAuth) {
      syncGroupSecretMetadata(items, groupId, {
        oauthConfigured: false,
        oauthExpires: undefined,
        oauthAccountId: undefined,
        oauthProjectId: undefined,
      });
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
      item.name = GEMINI_OAUTH_NAME;
      item.channelId = 'google-ai';
      delete item.wireOverride;
      item.provider = 'openai';
      item.baseUrl = GEMINI_CODE_ASSIST_BASE_URL;
    }
    if (item.authMethod === 'oauth_grok') {
      item.name = 'Grok 官方';
      item.channelId = 'grok';
      delete item.wireOverride;
      item.provider = 'openai';
      item.baseUrl = defaultsForChannel('grok').baseUrl;
      item.supportsReasoning = true;
    }
    if (item.authMethod === 'qoder_local_auth' || item.authMethod === 'local_cli') {
      item.authMethod = 'qoder_local_auth';
      item.channelId = 'qoder';
      delete item.wireOverride;
      item.provider = 'openai';
      item.baseUrl = defaultsForChannel('qoder').baseUrl;
      syncGroupSecretMetadata(items, groupId, {
        apiKeyConfigured: false,
        apiKeyMasked: undefined,
      });
      applyQoderModelMetadata(item);
      applyExplicitModelMetadataPatch(item, patch);
    }
    const resolved = resolveChannel({
      ...item,
      apiKey: item.apiKeyConfigured || item.oauthConfigured ? 'configured' : '',
      accountId: oauthStatusOf(item)?.accountId,
    });
    item.provider = legacyProviderForWire(resolved.wire);
    items[idx] = item;
    return withGroupSecretTransaction(
      groupId,
      () => {
        if (patch.apiKey !== undefined) setGroupApiKey(groupId, patch.apiKey || '');
        if (leavingOAuth) {
          setGroupOAuthTokens(groupId, null);
        }
        if (isLocalCliAuthMethod(item.authMethod)) setGroupApiKey(groupId, '');
      },
      () => {
        writeAll(items);
        return toView(item);
      },
    );
  }

  function removeProvider(id) {
    let items = readAll();
    const removed = items.find((i) => i.id === id);
    items = items.filter((i) => i.id !== id);
    if (removed?.isDefault && items.length > 0) {
      items[0].isDefault = true;
    }
    // A model and its channel have separate lifecycles. In particular, removing the
    // final model keeps the channel and its credentials so models can be re-added.
    writeAll(items);
    return items.map(toView);
  }

  // B-2 删除整个 provider 组(同 groupId 的全部模型)。
  // 若删掉的组里含当前默认模型,则把剩余首条记录设为默认(与 removeProvider 一致)。
  function removeGroup(groupId) {
    let items = readAll();
    const removed = items.filter((i) => groupKey(i) === groupId);
    const hadDefault = removed.some((i) => i.isDefault);
    items = items.filter((i) => groupKey(i) !== groupId);
    if (hadDefault && items.length > 0) {
      items[0].isDefault = true;
    }
    const state = readStoredState();
    const channelExists = state.channels.some((channel) => (channel.id || channel.groupId) === groupId);
    if (!channelExists) {
      writeAll(items);
      return items.map(toView);
    }
    const remainingChannels = state.channels.filter(
      (channel) => (channel.id || channel.groupId) !== groupId,
    );
    return withGroupSecretTransaction(
      groupId,
      () => removeGroupSecrets(groupId),
      () => {
        writeAll(items, remainingChannels);
        return items.map(toView);
      },
    );
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
  // 副本：新 id/新 groupId、不继承默认标记、不复制 OAuth token，名称智能去重。
  // API Key 与 OAuth client secret 按产品决策复制到副本自己的 Vault 键，副本开箱即用。
  function duplicateProvider(id) {
    const items = readAll();
    const source = items.find((i) => i.id === id);
    if (!source) throw new Error(`Provider ${id} not found`);
    if (isOAuthAuthMethod(source.authMethod)) {
      throw new Error('Subscription providers cannot be duplicated');
    }
    const copyId = randomUUID();
    const copy = {
      ...source,
      id: copyId,
      groupId: copyId,
      name: nextCopyName(source.name, items.map((i) => i.name)),
      oauthConfigured: false,
      oauthExpires: undefined,
      oauthAccountId: undefined,
      isDefault: false,
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    const sourceApiKey = readApiKey(source);
    copy.apiKeyConfigured = Boolean(sourceApiKey);
    copy.apiKeyMasked = sourceApiKey ? maskApiKey(sourceApiKey) : undefined;
    items.push(copy);
    return withGroupSecretTransaction(
      copy.groupId,
      () => {
        setGroupApiKey(copy.groupId, sourceApiKey);
        setGroupOAuthTokens(copy.groupId, null);
      },
      () => {
        writeAll(items);
        return toView(copy);
      },
    );
  }

  // B-2 在已有 provider 组内新增一个模型:凭证(apiKey/baseUrl/provider 归属)
  // 继承自组内首条记录,调用方无需重填凭证;模型级参数由 patch 提供。
  // 复用 addProvider 的完整 wire/channel/定价解析,保证路由字段正确。
  // 所有认证类型都允许在同一连接下持久化多个已配置模型；目录本身只提供候选。
  // 同渠道复制一条模型配置：新 id、model 追加 -copy、显示名追加「副本」/(Copy)，
  // 模型侧元数据一并克隆；连接信息与密钥由 group 继承（走 addModel）。
  function duplicateModel(id) {
    const items = readAll();
    const source = items.find((i) => i.id === id);
    if (!source) throw new Error(`Provider ${id} not found`);
    const groupId = source.groupId || source.id;
    const siblings = items.filter((i) => (i.groupId || i.id) === groupId);
    const modelId = nextCopyModelId(
      source.model,
      siblings.map((s) => s.model),
    );
    const copyName = nextCopyName(
      source.name || source.modelLabel || source.model || 'model',
      siblings.map((s) => s.name),
    );
    const sourceLabel = source.modelLabel || source.name || source.model || 'model';
    const copyLabel = nextCopyName(
      sourceLabel,
      siblings.map((s) => s.modelLabel || s.name),
    );
    return addModel(groupId, {
      model: modelId,
      name: copyName,
      modelLabel: copyLabel,
      contextWindow: source.contextWindow,
      maxOutputTokens: source.maxOutputTokens,
      inputPrice: source.inputPrice,
      outputPrice: source.outputPrice,
      cacheWritePrice: source.cacheWritePrice,
      cacheReadPrice: source.cacheReadPrice,
      supportsVision: source.supportsVision,
      supportsReasoning: source.supportsReasoning,
      supportsPromptCaching: source.supportsPromptCaching,
      reasoningParamStyle: source.reasoningParamStyle,
      reasoningEffortMap: source.reasoningEffortMap,
      modelOptions: source.modelOptions,
      modelOptionValues: source.modelOptionValues,
      metadataSource: source.metadataSource,
      pricingSource: source.pricingSource,
      metadataSyncedAt: source.metadataSyncedAt,
    });
  }

  function addModel(groupId, patch = {}) {
    if (!groupId) throw new Error('groupId is required');
    const items = readAll();
    const state = readStoredState();
    const source = items.find((i) => (i.groupId || i.id) === groupId)
      || state.channels.find((channel) => (channel.id || channel.groupId) === groupId);
    if (!source) throw new Error(`Provider group ${groupId} not found`);
    const model = String(patch.model || '').trim();
    if (!model) throw new Error('model is required');
    if (items.some((item) => (item.groupId || item.id) === groupId && item.model === model)) {
      throw new Error(`Model ${model} already exists in provider group`);
    }
    return addProvider({
      // 凭证与 provider 归属继承自组内首条记录
      groupId,
      provider: source.provider,
      channelId: source.channelId,
      wireOverride: source.wireOverride,
      authMethod: source.authMethod || 'api_key',
      baseUrl: source.baseUrl,
      // 模型级参数来自 patch；连接和凭证仍继承同组记录。
      name: patch.name || source.name,
      model,
      modelLabel: patch.modelLabel,
      metadataSource: patch.metadataSource,
      pricingSource: patch.pricingSource,
      metadataSyncedAt: patch.metadataSyncedAt,
      contextWindow: patch.contextWindow,
      maxOutputTokens: patch.maxOutputTokens,
      modelOptions: normalizeModelOptions(patch.modelOptions),
      modelOptionValues: normalizeModelOptionValues(patch.modelOptionValues),
      inputPrice: patch.inputPrice,
      outputPrice: patch.outputPrice,
      cacheWritePrice: patch.cacheWritePrice,
      cacheReadPrice: patch.cacheReadPrice,
      supportsVision: patch.supportsVision,
      supportsReasoning: patch.supportsReasoning,
      supportsPromptCaching: patch.supportsPromptCaching,
      reasoningParamStyle: patch.reasoningParamStyle,
      reasoningEffortMap: patch.reasoningEffortMap,
      customHeaders: patch.customHeaders ?? source.customHeaders,
    });
  }

  function getDecryptedApiKey(id) {
    const items = readAll();
    const item = items.find((i) => i.id === id);
    if (!item) return null;
    return readApiKey(item);
  }

  // 返回订阅凭据 { tokens }；秘密仅在真实请求路径中通过 Helper 解封。
  function getCredential(id) {
    const items = readAll();
    const item = items.find((i) => i.id === id);
    if (!item) return null;
    return {
      tokens: readOAuthTokens(item),
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
    const apiKey = readApiKey(item);
    if (!apiKey) return null;
    const resolved = resolveChannel({ ...item, apiKey });
    const catalogResolved = resolveModelCatalogRequestConfig({ ...item, apiKey });
    return {
      wire: resolved.wire,
      baseUrl: resolved.baseUrl,
      headers: resolved.headers,
      apiKey,
      // 渠道声明的目录平面覆盖(如 DeepSeek 走 OpenAI 兼容平面拉目录)；
      // 无覆盖的渠道为 undefined，目录行为保持历史不变。
      modelCatalog: catalogResolved.modelCatalogOverride
        ? {
            channelId: catalogResolved.channelId,
            wire: catalogResolved.wire,
            baseUrl: catalogResolved.baseUrl,
            headers: catalogResolved.headers,
          }
        : undefined,
    };
  }

  // 写入/刷新订阅 token 集合。秘密进入统一 Vault，配置文件只保存连接状态元数据。
  // tokens 形如 { access, refresh, expires, accountId }。
  function setOAuthTokens(id, tokens) {
    const items = readAll();
    const idx = items.findIndex((i) => i.id === id);
    if (idx < 0) throw new Error(`Provider ${id} not found`);
    const item = items[idx];
    const groupId = groupKey(item);
    syncGroupSecretMetadata(items, groupId, {
      oauthConfigured: Boolean(tokens?.access),
      oauthExpires: typeof tokens?.expires === 'number' ? tokens.expires : undefined,
      oauthAccountId: tokens?.accountId ? String(tokens.accountId) : undefined,
    });
    return withGroupSecretTransaction(
      groupId,
      () => setGroupOAuthTokens(groupId, tokens),
      () => {
        writeAll(items);
        return toView(item);
      },
    );
  }

  async function testConnection(id) {
    const items = readAll();
    const item = items.find((i) => i.id === id);
    if (!item) {
      return enrichTestResultWithDiagnostics(
        { success: false, error: 'Provider not found' },
        { connectionId: id, trigger: 'user' },
      );
    }

    const diagnosticContext = {
      connectionId: id,
      configVersion: item.configVersion,
      authMethod: item.authMethod,
      hasApiKey: Boolean(item.apiKeyConfigured),
      baseUrl: item.baseUrl,
      trigger: 'user',
    };

    // 订阅(ChatGPT OAuth)provider 不持有 apiKey；连通性以 OAuth 登录态为准。
    // 真正的远程模型探测走 `llm:models:list`(main 层,含 token 刷新)，此处只判定凭证有效性，
    // 避免存储层反向依赖 provider 网络适配器，也避免对订阅误报 "API key not configured"。
    let result;
    if (isOAuthAuthMethod(item.authMethod)) {
      result = resolveSubscriptionTestResult(oauthStatusOf(item), item.model);
    } else if (isLocalCliAuthMethod(item.authMethod)) {
      result = enrichTestResultWithDiagnostics(
        await testQoderPrivate(item.model),
        diagnosticContext,
      );
    } else {
      const apiKey = readApiKey(item);
      if (!apiKey) {
        result = enrichTestResultWithDiagnostics(
          { success: false, error: 'API key not configured' },
          { ...diagnosticContext, hasApiKey: false },
        );
      } else {
        const start = Date.now();
        try {
          const resolved = resolveChannel({ ...item, apiKey });
          if (resolved.wire === 'anthropic-messages') {
            result = await testAnthropic(resolved, item.model, start, providerFetch);
          } else if (resolved.wire === 'openai-responses') {
            result = await testOpenAIResponses(resolved, item.model, start, providerFetch);
          } else if (resolved.wire === 'gemini') {
            result = await testGemini(resolved, item.model, start, providerFetch);
          } else {
            result = await testOpenAI(resolved, item.model, start, providerFetch);
          }
          result = enrichTestResultWithDiagnostics(result, {
            ...diagnosticContext,
            hasApiKey: true,
          });
        } catch (err) {
          result = enrichTestResultWithDiagnostics(
            {
              success: false,
              error: err?.message || 'Connection failed',
              latencyMs: Date.now() - start,
            },
            {
              ...diagnosticContext,
              hasApiKey: true,
            },
          );
        }
      }
    }

    // 把最近诊断结果写回连接，供服务详情/列表读取。
    const nextItems = readAll();
    const nextItem = nextItems.find((entry) => entry.id === id);
    if (nextItem && result) {
      const now = new Date().toISOString();
      nextItem.lastCheckedAt = now;
      nextItem.lastDiagnostic = result.diagnostic;
      nextItem.lastErrorCategory = result.errorCategory;
      nextItem.connectionState = result.connectionState || nextItem.connectionState;
      nextItem.connectionStateReason = result.connectionStateReason || nextItem.connectionStateReason;
      if (result.success) nextItem.lastSuccessAt = now;
      nextItem.configVersion = Number(nextItem.configVersion || 0) || 1;
      writeAll(nextItems);
    }

    return result;
  }


  /**
   * Backfill missing price fields for saved models from models.dev.
   * Only fills undefined price fields; never overwrites existing values.
   */
  async function backfillMissingPricingFromModelsDev({
    fetchImpl = providerFetch,
    timeoutMs,
    cacheTtlMs,
  } = {}) {
    const registry = await fetchModelsDevRegistry({ fetchImpl, timeoutMs, cacheTtlMs });
    if (!registry || registry.size === 0) {
      return { updated: 0, examined: 0, skipped: true };
    }

    const items = readAll();
    let updated = 0;
    const nextItems = items.map((item) => {
      const { item: filled, changed } = fillMissingPricingFromRegistry(item, registry);
      if (changed) updated += 1;
      return filled;
    });

    if (updated > 0) writeAll(nextItems);
    return { updated, examined: items.length, skipped: false };
  }


  async function completePrompt({ id, prompt, maxTokens = 400 } = {}) {
    const connectionId = String(id || '').trim();
    const userPrompt = String(prompt || '').trim();
    if (!connectionId) return { success: false, error: 'Provider not found', text: '' };
    if (!userPrompt) return { success: false, error: 'Prompt required', text: '' };

    const items = readAll();
    const item = items.find((entry) => entry.id === connectionId);
    if (!item) return { success: false, error: 'Provider not found', text: '' };

    // One-shot completion is for API-key providers. OAuth/subscription models use the chat runtime.
    if (isOAuthAuthMethod(item.authMethod) || isLocalCliAuthMethod(item.authMethod)) {
      return {
        success: false,
        error: 'Selected model does not support one-shot detection. Choose an API-key model.',
        text: '',
      };
    }

    const apiKey = readApiKey(item);
    if (!apiKey) return { success: false, error: 'API key not configured', text: '' };

    const start = Date.now();
    const tokenLimit = Math.max(64, Math.min(1200, Number(maxTokens) || 400));
    try {
      const resolved = resolveChannel({ ...item, apiKey });
      const fetchImpl = providerFetch;
      let text = '';
      if (resolved.wire === 'anthropic-messages') {
        const res = await fetchImpl(resolved.endpoint, {
          method: 'POST',
          headers: resolved.headers,
          body: JSON.stringify({
            model: item.model,
            max_tokens: tokenLimit,
            messages: [{ role: 'user', content: userPrompt }],
          }),
          signal: AbortSignal.timeout(45000),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          return {
            success: false,
            error: body?.error?.message || `HTTP ${res.status}`,
            text: '',
            latencyMs: Date.now() - start,
          };
        }
        const blocks = Array.isArray(body?.content) ? body.content : [];
        text = blocks.map((block) => block?.text || '').join('').trim();
      } else if (resolved.wire === 'openai-responses') {
        const res = await fetchImpl(resolved.endpoint, {
          method: 'POST',
          headers: resolved.headers,
          body: JSON.stringify({
            model: item.model,
            input: [{ role: 'user', content: [{ type: 'input_text', text: userPrompt }] }],
            max_output_tokens: tokenLimit,
            store: false,
          }),
          signal: AbortSignal.timeout(45000),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          return {
            success: false,
            error: body?.error?.message || `HTTP ${res.status}`,
            text: '',
            latencyMs: Date.now() - start,
          };
        }
        if (typeof body?.output_text === 'string') text = body.output_text;
        else {
          const outputs = Array.isArray(body?.output) ? body.output : [];
          text = outputs
            .flatMap((itemOut) => (Array.isArray(itemOut?.content) ? itemOut.content : []))
            .map((part) => part?.text || '')
            .join('')
            .trim();
        }
      } else if (resolved.wire === 'gemini') {
        const res = await fetchImpl(resolved.testEndpoint || resolved.endpoint, {
          method: 'POST',
          headers: resolved.headers,
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
            generationConfig: { maxOutputTokens: tokenLimit },
          }),
          signal: AbortSignal.timeout(45000),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          return {
            success: false,
            error: body?.error?.message || `HTTP ${res.status}`,
            text: '',
            latencyMs: Date.now() - start,
          };
        }
        const parts = body?.candidates?.[0]?.content?.parts;
        text = Array.isArray(parts) ? parts.map((part) => part?.text || '').join('').trim() : '';
      } else {
        const res = await fetchImpl(resolved.endpoint, {
          method: 'POST',
          headers: resolved.headers,
          body: JSON.stringify({
            model: item.model,
            messages: [{ role: 'user', content: userPrompt }],
            max_tokens: tokenLimit,
            temperature: 0.2,
          }),
          signal: AbortSignal.timeout(45000),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          return {
            success: false,
            error: body?.error?.message || `HTTP ${res.status}`,
            text: '',
            latencyMs: Date.now() - start,
          };
        }
        text = String(body?.choices?.[0]?.message?.content || '').trim();
      }
      if (!text) {
        return { success: false, error: 'Empty model response', text: '', latencyMs: Date.now() - start };
      }
      return {
        success: true,
        text,
        model: item.model,
        providerId: item.id,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return {
        success: false,
        error: err?.message || String(err),
        text: '',
        latencyMs: Date.now() - start,
      };
    }
  }

  return { listProviders, listGroups, listChatProviders, addProvider, addModel, updateProvider, duplicateProvider, duplicateModel, removeProvider, removeGroup, setDefault, getDecryptedApiKey, getCredential, getApiKeyRequestConfig, setOAuthTokens, testConnection, completePrompt, backfillMissingPricingFromModelsDev };
}

async function testOpenAI(resolved, model, start, fetchImpl) {
  const url = resolved.endpoint;
  const res = await fetchImpl(url, {
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

async function testOpenAIResponses(resolved, model, start, fetchImpl) {
  const res = await fetchImpl(resolved.endpoint, {
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

async function testAnthropic(resolved, model, start, fetchImpl) {
  const url = resolved.endpoint;
  const res = await fetchImpl(url, {
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

async function testGemini(resolved, model, start, fetchImpl) {
  const res = await fetchImpl(resolved.testEndpoint || resolved.endpoint, {
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
