import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decryptQoderModelCache, resolveQoderConfigDir } from './qoder-local-auth.mjs';

const FALLBACK_QODER_MODELS = [
  { id: 'auto', label: 'Auto', contextWindow: 180_000, maxOutputTokens: 32_768, supportsVision: true, supportsReasoning: false },
];

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

function normalizeModel(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.key || raw.id || raw.model || '').trim();
  if (!id) return null;
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
    contextWindow: Number.isFinite(raw.max_input_tokens) ? raw.max_input_tokens : undefined,
    maxOutputTokens: Number.isFinite(raw.max_output_tokens) ? raw.max_output_tokens : undefined,
    supportsVision: typeof raw.is_vl === 'boolean' ? raw.is_vl : undefined,
    supportsReasoning: typeof raw.is_reasoning === 'boolean' ? raw.is_reasoning : undefined,
    raw,
  };
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
  for (const candidate of encryptedCatalogCandidates(uid, options)) {
    try {
      const encrypted = await fsp.readFile(candidate, 'utf8');
      const text = await decryptQoderModelCache(encrypted, uid, options);
      const models = parseQoderModelCatalogText(text);
      if (models.length) return { models, source: path.basename(candidate) };
    } catch {}
  }
  throw new Error('qoder_encrypted_models_unavailable');
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
  try {
    const models = readEncryptedCatalogSync(options);
    if (models.length) return mergeModelCatalog(models, readLegacyModelCatalog(options));
  } catch {}
  try {
    const models = parseQoderModelCatalogText(fs.readFileSync(modelPath(options), 'utf8'));
    return models.length ? models : [...FALLBACK_QODER_MODELS];
  } catch {
    return [...FALLBACK_QODER_MODELS];
  }
}

export function getQoderModelMetadata(modelId, options = {}) {
  const id = String(modelId || '').trim().toLowerCase();
  if (!id) return null;
  return getQoderModelCatalog(options).find((model) => model.id.toLowerCase() === id) || null;
}

export async function listQoderModels(options = {}) {
  try {
    const result = await readEncryptedCatalog(options);
    return { models: mergeModelCatalog(result.models, await readLegacyModelCatalogAsync(options)), source: result.source };
  } catch {}
  try {
    const text = await fsp.readFile(modelPath(options), 'utf8');
    const models = parseQoderModelCatalogText(text);
    if (models.length) return { models, source: 'local' };
    return { models: [...FALLBACK_QODER_MODELS], source: 'fallback', error: 'qoder_models_empty' };
  } catch (error) {
    return {
      models: [...FALLBACK_QODER_MODELS],
      source: 'fallback',
      error: error?.code === 'ENOENT' ? 'qoder_models_not_found' : 'qoder_models_unavailable',
    };
  }
}

export function qoderModelsPathForDebug({ env = process.env, homeDir = os.homedir() } = {}) {
  return modelPath({ env, homeDir });
}
