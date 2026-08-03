import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decryptQoderModelCache, resolveQoderConfigDir } from './qoder-local-auth.mjs';
import { fetchOfficialQoderModelCatalog } from './qoder-official-model-catalog.mjs';

const FALLBACK_QODER_MODELS = [
  { id: 'auto', label: 'Auto', contextWindow: 180_000, maxOutputTokens: 32_768, supportsVision: true, supportsReasoning: false },
];

const latestCatalogByConfigDir = new Map();
/** 本地读盘短缓存：避免 goal tick / metadata 热路径反复 readFileSync。 */
const localCatalogReadCache = new Map();
const LOCAL_CATALOG_TTL_MS = 5_000;

function catalogCacheKey(options = {}) {
  return resolveQoderConfigDir(options);
}

function readLocalCatalogCached(options = {}) {
  const key = catalogCacheKey(options);
  const hit = localCatalogReadCache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < LOCAL_CATALOG_TTL_MS) return hit.models;
  let models;
  try {
    const encrypted = readEncryptedCatalogSync(options);
    if (encrypted.length) {
      models = mergeModelCatalog(encrypted, readLegacyModelCatalog(options));
    } else {
      models = null;
    }
  } catch {
    models = null;
  }
  if (!models) {
    try {
      const parsed = parseQoderModelCatalogText(fs.readFileSync(modelPath(options), 'utf8'));
      models = parsed.length ? parsed : [...FALLBACK_QODER_MODELS];
    } catch {
      models = [...FALLBACK_QODER_MODELS];
    }
  }
  localCatalogReadCache.set(key, { at: now, models });
  return models;
}

function modelPath(options = {}) {
  return path.join(resolveQoderConfigDir(options), '.auth/models');
}

function modelsDir(options = {}) {
  return path.join(resolveQoderConfigDir(options), '.models');
}

function defaultModelPath(options = {}) {
  return path.join(modelsDir(options), 'default');
}

function encryptedCatalogCandidates(uid, options = {}) {
  const dir = path.join(modelsDir(options), uid);
  return ['catalog-v5', 'catalog-v4', 'catalog-v2', 'catalog'].map((name) => path.join(dir, name));
}

// Peer Agent effort order (UI). Qoder catalog uses low/medium/high/xhigh/max;
// disabled thinking maps to our "off".
const QODER_EFFORT_ORDER = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];

function thinkingConfigOf(raw) {
  if (raw?.thinking_config && typeof raw.thinking_config === 'object') return raw.thinking_config;
  if (raw?.serverModel?.thinking_config && typeof raw.serverModel.thinking_config === 'object') {
    return raw.serverModel.thinking_config;
  }
  return null;
}

/**
 * Project Qoder thinking_config into Peer Agent reasoning effort levels.
 * - disabled present → include "off"
 * - enabled.efforts keys → low/medium/high/xhigh/max (stable order)
 * - default from enabled.efforts[*].is_default, else enabled.is_default → first effort, else off if allowed
 */
function resolveThinkingEffortProjection(raw) {
  const thinking = thinkingConfigOf(raw);
  if (!thinking || typeof thinking !== 'object') return null;

  const hasDisabled = Boolean(thinking.disabled && typeof thinking.disabled === 'object');
  const enabled = thinking.enabled && typeof thinking.enabled === 'object' ? thinking.enabled : null;
  if (!enabled && !hasDisabled) return null;

  const effortKeys = enabled?.efforts && typeof enabled.efforts === 'object'
    ? Object.keys(enabled.efforts).map((key) => String(key || '').trim().toLowerCase()).filter(Boolean)
    : [];
  const levels = [];
  if (hasDisabled) levels.push('off');
  for (const key of QODER_EFFORT_ORDER) {
    if (key === 'off') continue;
    if (effortKeys.includes(key) && !levels.includes(key)) levels.push(key);
  }
  // Preserve any unknown effort names after known ones (defensive).
  for (const key of effortKeys) {
    if (!levels.includes(key) && key !== 'default') levels.push(key);
  }
  if (!levels.length) return null;

  let defaultEffort;
  if (enabled?.efforts && typeof enabled.efforts === 'object') {
    const defaultEntry = Object.entries(enabled.efforts)
      .find(([, config]) => config && typeof config === 'object' && config.is_default === true);
    if (defaultEntry) defaultEffort = String(defaultEntry[0] || '').trim().toLowerCase();
  }
  if (!defaultEffort && enabled?.is_default === true) {
    defaultEffort = levels.find((level) => level !== 'off') || levels[0];
  }
  if (!defaultEffort && hasDisabled && thinking.disabled?.is_default === true) {
    defaultEffort = 'off';
  }
  if (!defaultEffort || !levels.includes(defaultEffort)) {
    defaultEffort = levels.find((level) => level !== 'off') || levels[0];
  }

  return {
    supportsReasoning: true,
    reasoningEffortLevels: levels,
    reasoningDefaultEffort: defaultEffort,
  };
}

function normalizeContextTierOption(raw) {
  const entries = Object.entries(raw?.context_config || {})
    .filter(([key, config]) => key.trim() && config && Number.isFinite(config.token_count) && config.token_count > 0);
  if (!entries.length) return undefined;

  const defaultEntry = entries.find(([, config]) => config.is_default === true) || entries[0];
  const defaultContextWindow = defaultEntry[1].token_count;
  const defaultInputTokenLimit = Number.isFinite(raw.max_input_tokens) && raw.max_input_tokens > 0
    ? raw.max_input_tokens
    : defaultContextWindow;
  // 预留量必须锚定「能装下官方 max_input_tokens 的最小档位」，而不是默认档。
  // Cantus 形态（默认档 1M、max_input_tokens 180k）下若锚定默认档会预留 820k，
  // 把 1M 档可用输入压成 180k、小档位塌缩成 1；锚定最小可用档（200K）则预留 20k，
  // 各档投影 980k/380k/180k。旧形态（默认 200K + 180k）锚点不变，结果向后兼容。
  const sortedByWindow = [...entries].sort((a, b) => a[1].token_count - b[1].token_count);
  const anchorEntry = sortedByWindow.find(([, config]) => config.token_count >= defaultInputTokenLimit)
    || sortedByWindow[sortedByWindow.length - 1];
  const reservedTokens = Math.max(0, anchorEntry[1].token_count - defaultInputTokenLimit);

  return {
    id: 'contextTier',
    label: '上下文档位',
    kind: 'select',
    description: '总上下文窗口；最大输入会为模型输出和运行时内容预留空间。',
    defaultValue: defaultEntry[0],
    choices: entries.map(([key, config]) => ({
      value: key,
      label: key,
      requestValue: key,
      contextWindow: config.token_count,
      inputTokenLimit: Math.max(1, config.token_count - reservedTokens),
    })),
  };
}

export function resolveQoderModelOptionProjection(metadata, values = {}) {
  const definitions = Array.isArray(metadata?.modelOptions) ? metadata.modelOptions : [];
  const definition = definitions.find((option) => option?.id === 'contextTier' && option.kind === 'select');
  if (!definition) {
    return {
      contextWindow: metadata?.contextWindow,
      inputTokenLimit: metadata?.contextWindow,
      requestOptions: {},
    };
  }

  const requestedValue = typeof values?.contextTier === 'string' ? values.contextTier : undefined;
  const choice = definition.choices.find((item) => item.value === requestedValue)
    || definition.choices.find((item) => item.value === definition.defaultValue)
    || definition.choices[0];
  if (!choice) {
    return {
      contextWindow: metadata?.contextWindow,
      inputTokenLimit: metadata?.contextWindow,
      requestOptions: {},
    };
  }

  return {
    contextWindow: choice.contextWindow ?? metadata?.contextWindow,
    inputTokenLimit: choice.inputTokenLimit ?? metadata?.contextWindow,
    requestOptions: {
      contextTier: choice.requestValue ?? choice.value,
    },
  };
}

function normalizeModel(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.key || raw.id || raw.model || '').trim();
  if (!id) return null;
  const contextTierOption = normalizeContextTierOption(raw);
  // thinking_config is the source of truth for effort UI; fall back to is_reasoning
  // only when the catalog has no thinking_config (legacy models).
  const thinkingProjection = resolveThinkingEffortProjection(raw);
  const supportsReasoning = thinkingProjection
    ? true
    : (typeof raw.is_reasoning === 'boolean' ? raw.is_reasoning : undefined);
  return {
    id,
    label: String(raw.display_name || raw.displayName || raw.label || id),
    source: String(raw.source || 'system'),
    format: String(raw.format || 'openai'),
    enabled: typeof raw.enable === 'boolean' ? raw.enable : undefined,
    isDefault: typeof raw.is_default === 'boolean' ? raw.is_default : undefined,
    isNew: typeof raw.is_new === 'boolean' ? raw.is_new : undefined,
    priceFactor: Number.isFinite(raw.price_factor) ? raw.price_factor : undefined,
    originalPriceFactor: Number.isFinite(raw.original_price_factor) ? raw.original_price_factor : undefined,
    contextWindow: Number.isFinite(raw.max_input_tokens) && raw.max_input_tokens > 0
      ? raw.max_input_tokens
      : undefined,
    maxOutputTokens: Number.isFinite(raw.max_output_tokens) ? raw.max_output_tokens : undefined,
    supportsVision: typeof raw.is_vl === 'boolean' ? raw.is_vl : undefined,
    supportsReasoning,
    reasoningEffortLevels: thinkingProjection?.reasoningEffortLevels,
    reasoningDefaultEffort: thinkingProjection?.reasoningDefaultEffort,
    modelOptions: contextTierOption ? [contextTierOption] : undefined,
    raw,
  };
}

function officialContextConfig(raw) {
  if (raw?.context_config && typeof raw.context_config === 'object') return raw.context_config;
  if (raw?.serverModel?.context_config && typeof raw.serverModel.context_config === 'object') {
    return raw.serverModel.context_config;
  }
  const windows = Array.isArray(raw?.availableContextWindows)
    ? raw.availableContextWindows.filter((value) => Number.isFinite(value) && value > 0)
    : [];
  if (!windows.length) return undefined;
  const defaultWindow = Number.isFinite(raw.defaultContextWindow)
    ? raw.defaultContextWindow
    : windows[0];
  return Object.fromEntries(windows.map((tokenCount) => [String(tokenCount), {
    token_count: tokenCount,
    is_default: tokenCount === defaultWindow,
  }]));
}

function normalizeOfficialModel(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const serverModel = raw.serverModel && typeof raw.serverModel === 'object' && !Array.isArray(raw.serverModel)
    ? raw.serverModel
    : {};
  const id = String(raw.modelId || raw.value || serverModel.key || '').trim();
  if (!id) return null;
  return normalizeModel({
    ...serverModel,
    key: id,
    display_name: raw.displayName ?? serverModel.display_name,
    source: raw.source ?? serverModel.source,
    format: raw.format ?? serverModel.format,
    enable: raw.isEnabled ?? serverModel.enable,
    is_default: raw.isDefault ?? serverModel.is_default,
    is_new: raw.isNew ?? serverModel.is_new,
    price_factor: raw.priceFactor ?? serverModel.price_factor,
    original_price_factor: raw.originalPriceFactor ?? serverModel.original_price_factor,
    max_input_tokens: raw.maxInputTokens ?? serverModel.max_input_tokens,
    max_output_tokens: raw.maxOutputTokens ?? serverModel.max_output_tokens,
    is_vl: raw.isVl ?? serverModel.is_vl,
    is_reasoning: raw.isReasoning ?? serverModel.is_reasoning,
    context_config: officialContextConfig(raw),
    thinking_config: raw.thinking_config
      ?? raw.thinkingConfig
      ?? serverModel.thinking_config
      ?? serverModel.thinkingConfig,
  });
}

function normalizeOfficialCatalog(entries) {
  const seen = new Set();
  const models = [];
  for (const raw of Array.isArray(entries) ? entries : []) {
    const model = normalizeOfficialModel(raw);
    const key = model?.id.toLowerCase();
    if (!model || seen.has(key)) continue;
    seen.add(key);
    models.push(model);
  }
  return models;
}

function pickQoderChatModels(catalog) {
  const groups = ['chat', 'assistant'];
  for (const group of groups) {
    const models = Array.isArray(catalog?.[group]) ? catalog[group] : [];
    if (models.length) return models;
  }
  return [];
}

function parseQoderModelCatalogText(text) {
  const catalog = JSON.parse(text);
  const seen = new Set();
  const models = [];
  for (const raw of pickQoderChatModels(catalog)) {
    const model = normalizeModel(raw);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models;
}

function readLegacyModelCatalog(options = {}) {
  try {
    const models = parseQoderModelCatalogText(fs.readFileSync(modelPath(options), 'utf8'));
    return models.length ? models : [];
  } catch {
    return [];
  }
}

async function readLegacyModelCatalogAsync(options = {}) {
  try {
    const models = parseQoderModelCatalogText(await fsp.readFile(modelPath(options), 'utf8'));
    return models.length ? models : [];
  } catch {
    return [];
  }
}

function mergeModelCatalog(primary, fallback) {
  const fallbackById = new Map((fallback || []).map((model) => [model.id.toLowerCase(), model]));
  return (primary || []).map((model) => {
    const fallbackModel = fallbackById.get(model.id.toLowerCase());
    if (!fallbackModel) return model;
    return {
      ...fallbackModel,
      ...model,
      maxOutputTokens: model.maxOutputTokens ?? fallbackModel.maxOutputTokens,
    };
  });
}

async function readEncryptedCatalog(options = {}) {
  const defaultInfo = JSON.parse(await fsp.readFile(defaultModelPath(options), 'utf8'));
  const uid = String(defaultInfo?.uid || '').trim();
  if (!uid) throw new Error('qoder_models_uid_missing');
  let lastError = null;
  let sawEncryptedFile = false;
  for (const candidate of encryptedCatalogCandidates(uid, options)) {
    try {
      const encrypted = await fsp.readFile(candidate, 'utf8');
      sawEncryptedFile = true;
      const text = await decryptQoderModelCache(encrypted, uid, options);
      const models = parseQoderModelCatalogText(text);
      if (models.length) return { models, source: path.basename(candidate) };
      lastError = new Error('qoder_encrypted_models_empty');
    } catch (error) {
      // ENOENT: 当前候选不存在，继续尝试更旧版本；其他错误（解密/wasm/解析）保留最后一次原因。
      if (error?.code !== 'ENOENT') lastError = error;
    }
  }
  if (!sawEncryptedFile) {
    const notFound = new Error('qoder_models_not_found');
    notFound.code = 'ENOENT';
    throw notFound;
  }
  const failure = lastError instanceof Error
    ? lastError
    : new Error('qoder_encrypted_models_unavailable');
  throw failure;
}

function readEncryptedCatalogSync(options = {}) {
  const defaultInfo = JSON.parse(fs.readFileSync(defaultModelPath(options), 'utf8'));
  const uid = String(defaultInfo?.uid || '').trim();
  if (!uid) throw new Error('qoder_models_uid_missing');
  for (const candidate of encryptedCatalogCandidates(uid, options)) {
    try {
      const encrypted = fs.readFileSync(candidate, 'utf8');
      // getQoderModelCatalog is synchronous for the config-store migration path.
      // Keep it on the legacy JSON cache; async callers use catalog-v5.
      if (encrypted.trim().startsWith('{')) {
        const models = parseQoderModelCatalogText(encrypted);
        if (models.length) return models;
      }
    } catch {}
  }
  throw new Error('qoder_encrypted_models_sync_unavailable');
}

export function getQoderModelCatalog(options = {}) {
  const cached = latestCatalogByConfigDir.get(catalogCacheKey(options));
  if (cached?.length) return cached;
  // 本地 catalog 读盘短缓存（5s），热路径复用；远程 list 仍写入 latestCatalogByConfigDir。
  return readLocalCatalogCached(options);
}

export function getQoderModelMetadata(modelId, options = {}) {
  const id = String(modelId || '').trim().toLowerCase();
  if (!id) return null;
  return getQoderModelCatalog(options).find((model) => model.id.toLowerCase() === id) || null;
}

export async function listQoderModels(options = {}) {
  let officialError = null;
  try {
    const loadOfficialCatalog = options.officialCatalogLoader ?? fetchOfficialQoderModelCatalog;
    const models = normalizeOfficialCatalog(await loadOfficialCatalog(options));
    if (models.length) {
      latestCatalogByConfigDir.set(catalogCacheKey(options), models);
      return { models, source: 'remote' };
    }
    officialError = new Error('qoder_official_models_empty');
  } catch (error) {
    officialError = error;
  }

  let encryptedError = null;
  try {
    const result = await readEncryptedCatalog(options);
    const models = mergeModelCatalog(result.models, await readLegacyModelCatalogAsync(options));
    latestCatalogByConfigDir.set(catalogCacheKey(options), models);
    return { models, source: 'local' };
  } catch (error) {
    encryptedError = error;
  }
  try {
    const text = await fsp.readFile(modelPath(options), 'utf8');
    const models = parseQoderModelCatalogText(text);
    if (models.length) {
      latestCatalogByConfigDir.set(catalogCacheKey(options), models);
      return { models, source: 'local' };
    }
    return {
      models: [...FALLBACK_QODER_MODELS],
      source: 'fallback',
      error: classifyQoderCatalogError(
        encryptedError && encryptedError.code !== 'ENOENT'
          ? encryptedError
          : officialError || new Error('qoder_models_empty'),
      ),
    };
  } catch (error) {
    const primary = encryptedError && encryptedError.code !== 'ENOENT'
      ? encryptedError
      : officialError || error;
    return {
      models: [...FALLBACK_QODER_MODELS],
      source: 'fallback',
      error: classifyQoderCatalogError(primary),
    };
  }
}

function classifyQoderCatalogError(error) {
  if (!error) return 'qoder_models_not_found';
  const code = String(error.code || error.message || '').trim();
  if (!code || code === 'ENOENT') return 'qoder_models_not_found';
  if (code === 'qoder_cli_not_found') return 'qoder_auth_wasm_not_found';
  if (code === 'qoder_official_models_empty') return 'qoder_models_empty';
  if (code === 'qoder_official_models_timeout' || code === 'qoder_official_models_unavailable') {
    return 'qoder_models_unavailable';
  }
  if (code.startsWith('qoder_')) return code;
  if (code.includes('wasm')) {
    return code.includes('not_found') ? 'qoder_auth_wasm_not_found' : 'qoder_auth_wasm_missing';
  }
  return 'qoder_models_unavailable';
}

export function qoderModelsPathForDebug({ env = process.env, homeDir = os.homedir() } = {}) {
  return modelPath({ env, homeDir });
}
