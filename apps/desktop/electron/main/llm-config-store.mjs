import { safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathOf } from './data-store.mjs';

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

const PROVIDER_DEFAULTS = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-20250514' },
};

export function createLlmConfigStore({ configFile = pathOf('llmProviders') } = {}) {
  function readAll() {
    if (!existsSync(configFile)) return [];
    try {
      const parsed = JSON.parse(readFileSync(configFile, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
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
      supportsVision: item.supportsVision ?? false,
      apiKeyMasked: maskApiKey(key),
      apiKeyConfigured: Boolean(key),
    };
  }

  function listProviders() {
    return readAll().map(toView);
  }

  function addProvider({ provider, name, baseUrl, model, apiKey, contextWindow, inputPrice, outputPrice, cacheWritePrice, cacheReadPrice, supportsVision }) {
    const items = readAll();
    const defaults = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.openai;
    const item = {
      id: randomUUID(),
      provider: provider || 'openai',
      name: name || provider || 'Untitled',
      baseUrl: baseUrl || defaults.baseUrl,
      model: model || defaults.model,
      apiKey: encrypt(apiKey || ''),
      enabled: true,
      isDefault: items.length === 0,
      createdAt: new Date().toISOString(),
      contextWindow: contextWindow || undefined,
      inputPrice: inputPrice ?? undefined,
      outputPrice: outputPrice ?? undefined,
      cacheWritePrice: cacheWritePrice ?? undefined,
      cacheReadPrice: cacheReadPrice ?? undefined,
      supportsVision: supportsVision ?? false,
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

  async function testConnection(id) {
    const items = readAll();
    const item = items.find((i) => i.id === id);
    if (!item) return { success: false, error: 'Provider not found' };

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

  return { listProviders, addProvider, updateProvider, removeProvider, setDefault, getDecryptedApiKey, testConnection };
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
