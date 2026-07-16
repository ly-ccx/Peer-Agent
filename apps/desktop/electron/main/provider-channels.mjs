import { buildClaudeCliIdentityHeaders } from './provider-adapters/anthropic-cli-identity.mjs';

export const CHATGPT_SUBSCRIPTION_NAME = 'ChatGPT 订阅';
export const CHATGPT_SUBSCRIPTION_BASE_URL = 'https://chatgpt.com/backend-api/codex';
export const GROK_OFFICIAL_NAME = 'Grok 官方';
export const GROK_SUBSCRIPTION_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
export const GEMINI_OAUTH_NAME = 'Gemini OAuth';
export const QODER_PRIVATE_NAME = 'Qoder 私有接口';

export const CHANNEL_IDS = {
  OPENAI: 'openai',
  ANTHROPIC: 'anthropic',
  OPENAI_COMPATIBLE: 'openai-compatible',
  ANTHROPIC_COMPATIBLE: 'anthropic-compatible',
  GOOGLE_AI: 'google-ai',
  GROK: 'grok',
  QODER: 'qoder',
};

const PROTECTED_HEADER_NAMES = new Set([
  'authorization',
  'x-api-key',
  'content-type',
  'anthropic-version',
  'openai-beta',
  'x-goog-api-key',
  'x-goog-user-project',
  'chatgpt-account-id',
  'x-xai-token-auth',
  'x-grok-client-surface',
  'x-grok-client-version',
]);

const CHANNEL_DESCRIPTORS = {
  [CHANNEL_IDS.OPENAI]: {
    id: CHANNEL_IDS.OPENAI,
    label: 'OpenAI 官方',
    legacyProvider: 'openai',
    defaultWire: 'openai-chat',
    allowedWires: ['openai-chat', 'openai-responses'],
    authMethods: {
      api_key: { wire: 'openai-chat' },
      oauth_chatgpt: { wire: 'openai-responses' },
    },
    defaults: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
    capabilities: {
      reasoning: {
        supported: true,
        paramStyle: 'openai-effort',
        effortLevels: ['low', 'default', 'high', 'xhigh'],
        defaultEffort: 'default',
      },
      promptCache: true,
      vision: true,
      toolUse: true,
      temperature: true,
    },
  },
  [CHANNEL_IDS.ANTHROPIC]: {
    id: CHANNEL_IDS.ANTHROPIC,
    label: 'Anthropic 官方',
    legacyProvider: 'anthropic',
    defaultWire: 'anthropic-messages',
    allowedWires: ['anthropic-messages'],
    authMethods: { api_key: { wire: 'anthropic-messages' } },
    defaults: { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-20250514' },
    headers: buildClaudeCliIdentityHeaders(),
    capabilities: {
      reasoning: {
        supported: true,
        paramStyle: 'anthropic-enabled-budget',
        effortLevels: ['low', 'default', 'high', 'xhigh'],
        defaultEffort: 'default',
      },
      promptCache: true,
      vision: true,
      toolUse: true,
      temperature: true,
    },
  },
  [CHANNEL_IDS.OPENAI_COMPATIBLE]: {
    id: CHANNEL_IDS.OPENAI_COMPATIBLE,
    label: 'OpenAI 兼容',
    legacyProvider: 'openai',
    defaultWire: 'openai-chat',
    allowedWires: ['openai-chat', 'openai-responses'],
    authMethods: { api_key: { wire: 'openai-chat' } },
    defaults: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
    capabilities: {
      reasoning: {
        supported: false,
        paramStyle: 'openai-effort',
        effortLevels: ['low', 'default', 'high', 'xhigh'],
        defaultEffort: 'default',
      },
      promptCache: false,
      vision: false,
      toolUse: true,
      temperature: true,
    },
  },
  [CHANNEL_IDS.ANTHROPIC_COMPATIBLE]: {
    id: CHANNEL_IDS.ANTHROPIC_COMPATIBLE,
    label: 'Anthropic 兼容',
    legacyProvider: 'anthropic',
    defaultWire: 'anthropic-messages',
    allowedWires: ['anthropic-messages'],
    authMethods: { api_key: { wire: 'anthropic-messages' } },
    defaults: { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-20250514' },
    headers: buildClaudeCliIdentityHeaders(),
    capabilities: {
      reasoning: {
        supported: false,
        paramStyle: 'anthropic-enabled-budget',
        effortLevels: ['low', 'default', 'high', 'xhigh'],
        defaultEffort: 'default',
      },
      promptCache: false,
      vision: false,
      toolUse: true,
      temperature: true,
    },
  },
  [CHANNEL_IDS.GOOGLE_AI]: {
    id: CHANNEL_IDS.GOOGLE_AI,
    label: 'Google AI / Gemini',
    legacyProvider: 'openai',
    defaultWire: 'gemini',
    allowedWires: ['gemini'],
    authMethods: {
      api_key: { wire: 'gemini' },
      oauth_google: { wire: 'gemini' },
    },
    defaults: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.0-flash' },
    capabilities: {
      reasoning: {
        supported: false,
        paramStyle: 'none',
        effortLevels: ['off', 'default'],
        defaultEffort: 'off',
      },
      promptCache: false,
      vision: true,
      toolUse: true,
      temperature: true,
    },
  },
  [CHANNEL_IDS.GROK]: {
    id: CHANNEL_IDS.GROK,
    label: GROK_OFFICIAL_NAME,
    legacyProvider: 'openai',
    defaultWire: 'openai-chat',
    allowedWires: ['openai-chat'],
    authMethods: { oauth_grok: { wire: 'openai-chat' } },
    defaults: { baseUrl: GROK_SUBSCRIPTION_BASE_URL, model: 'grok-4.5' },
    headers: {
      'X-XAI-Token-Auth': 'xai-grok-cli',
      'x-grok-client-surface': 'grok-build',
      'x-grok-client-version': '0.1.202',
    },
    capabilities: {
      reasoning: {
        supported: true,
        paramStyle: 'openai-effort',
        effortLevels: ['low', 'medium', 'high'],
        defaultEffort: 'high',
      },
      promptCache: false,
      vision: true,
      toolUse: true,
      temperature: true,
    },
  },
  [CHANNEL_IDS.QODER]: {
    id: CHANNEL_IDS.QODER,
    label: QODER_PRIVATE_NAME,
    legacyProvider: 'openai',
    defaultWire: 'qoder-private',
    allowedWires: ['qoder-private'],
    authMethods: {
      qoder_local_auth: { wire: 'qoder-private' },
      local_cli: { wire: 'qoder-private' },
    },
    defaults: { baseUrl: 'https://api2-v2.qoder.sh/model/v1', model: 'auto' },
    capabilities: {
      reasoning: {
        supported: false,
        paramStyle: 'none',
        effortLevels: ['off'],
        defaultEffort: 'off',
      },
      promptCache: false,
      vision: false,
      toolUse: false,
      temperature: false,
    },
  },
};

function normalizeReasoningEffortMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const normalized = {};
  for (const [key, raw] of Object.entries(value)) {
    const name = String(key || '').trim();
    if (!name) continue;
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      normalized[name] = raw;
    } else if (typeof raw === 'string' && raw.trim()) {
      normalized[name] = raw.trim();
    }
  }
  return Object.keys(normalized).length ? normalized : undefined;
}

export function listChannelDescriptors() {
  return Object.values(CHANNEL_DESCRIPTORS).map((descriptor) => structuredClone(descriptor));
}

export function getChannelDescriptor(channelId) {
  return CHANNEL_DESCRIPTORS[channelId] ?? null;
}

export function inferChannelId(config = {}) {
  if (typeof config.channelId === 'string' && config.channelId.trim()) return config.channelId;
  if (config.authMethod === 'oauth_chatgpt') return CHANNEL_IDS.OPENAI;
  if (config.authMethod === 'oauth_google') return CHANNEL_IDS.GOOGLE_AI;
  if (config.authMethod === 'oauth_grok') return CHANNEL_IDS.GROK;
  if (config.authMethod === 'qoder_local_auth' || config.authMethod === 'local_cli') return CHANNEL_IDS.QODER;
  if (config.provider === 'anthropic') return CHANNEL_IDS.ANTHROPIC;
  return CHANNEL_IDS.OPENAI_COMPATIBLE;
}

export function legacyProviderForWire(wire) {
  return wire === 'anthropic-messages' ? 'anthropic' : 'openai';
}

export function defaultsForChannel(channelId) {
  const descriptor = getChannelDescriptor(channelId) ?? CHANNEL_DESCRIPTORS[CHANNEL_IDS.OPENAI_COMPATIBLE];
  return { ...descriptor.defaults };
}

function normalizeHeaderName(name) {
  return String(name || '').trim().toLowerCase();
}

export function validateCustomHeaders(customHeaders = {}) {
  for (const key of Object.keys(customHeaders || {})) {
    const normalized = normalizeHeaderName(key);
    if (!normalized) {
      throw new Error('custom_header_name_empty');
    }
    if (PROTECTED_HEADER_NAMES.has(normalized)) {
      throw new Error(`custom_header_protected:${normalized}`);
    }
  }
}

function mergeHeaders(...parts) {
  const merged = {};
  for (const part of parts) {
    for (const [key, value] of Object.entries(part || {})) {
      if (value === undefined || value === null || value === '') continue;
      merged[key] = String(value);
    }
  }
  return merged;
}

function geminiModelPath(model) {
  const raw = String(model || '').trim();
  if (!raw) return 'models/gemini-2.0-flash';
  return raw.startsWith('models/') ? raw : `models/${raw}`;
}

function endpointForWire(baseUrl, wire, { model, apiKey, authMethod, stream = true } = {}) {
  const root = String(baseUrl || '').replace(/\/+$/, '');
  if (wire === 'qoder-private') return `${root}/chat/completions`;
  if (wire === 'anthropic-messages') return `${root}/v1/messages`;
  if (wire === 'openai-responses') return `${root}/responses`;
  if (wire === 'gemini') {
    const method = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    const keyParam = authMethod === 'oauth_google' || !apiKey
      ? ''
      : `${method.includes('?') ? '&' : '?'}key=${encodeURIComponent(apiKey)}`;
    return `${root}/${geminiModelPath(model)}:${method}${keyParam}`;
  }
  return `${root}/chat/completions`;
}

function requiredHeadersFor({ wire, apiKey, accountId, authMethod, oauthProjectId }) {
  if (wire === 'qoder-private') return {};
  if (wire === 'anthropic-messages') {
    return {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    };
  }
  if (wire === 'gemini') {
    const headers = { 'Content-Type': 'application/json' };
    if (authMethod === 'oauth_google') {
      headers.Authorization = `Bearer ${apiKey}`;
      if (oauthProjectId) headers['x-goog-user-project'] = oauthProjectId;
    }
    return headers;
  }
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
  if (wire === 'openai-responses') headers['OpenAI-Beta'] = 'responses=experimental';
  if (accountId) headers['chatgpt-account-id'] = accountId;
  return headers;
}

export function resolveChannel(config = {}) {
  const channelId = inferChannelId(config);
  const descriptor = getChannelDescriptor(channelId);
  if (!descriptor) throw new Error(`unknown_channel:${channelId}`);

  const authMethod = config.authMethod === 'oauth_chatgpt'
    ? 'oauth_chatgpt'
    : config.authMethod === 'oauth_google'
      ? 'oauth_google'
      : config.authMethod === 'oauth_grok'
        ? 'oauth_grok'
        : config.authMethod === 'qoder_local_auth' || config.authMethod === 'local_cli'
          ? 'qoder_local_auth'
          : 'api_key';
  const authRule = descriptor.authMethods[authMethod];
  if (!authRule) throw new Error(`unsupported_auth_method:${channelId}:${authMethod}`);

  const wireOverride = config.wireOverride || config.wire;
  const wire = authMethod === 'oauth_chatgpt' || authMethod === 'oauth_grok'
    ? authRule.wire
    : (wireOverride ?? authRule.wire ?? descriptor.defaultWire);
  if (wireOverride && !descriptor.allowedWires.includes(wireOverride)) {
    throw new Error(`unsupported_wire:${channelId}:${wireOverride}`);
  }
  if (!descriptor.allowedWires.includes(wire)) {
    throw new Error(`unsupported_wire:${channelId}:${wire}`);
  }
  if (authMethod === 'oauth_chatgpt' && wireOverride && wireOverride !== wire) {
    throw new Error(`unsupported_wire:${channelId}:${wireOverride}`);
  }
  if (authMethod === 'oauth_google' && wireOverride && wireOverride !== wire) {
    throw new Error(`unsupported_wire:${channelId}:${wireOverride}`);
  }
  if (authMethod === 'oauth_grok' && wireOverride && wireOverride !== wire) {
    throw new Error(`unsupported_wire:${channelId}:${wireOverride}`);
  }
  if (authMethod === 'qoder_local_auth' && wireOverride && wireOverride !== wire) {
    throw new Error(`unsupported_wire:${channelId}:${wireOverride}`);
  }

  const baseUrl = authMethod === 'oauth_chatgpt'
    ? CHATGPT_SUBSCRIPTION_BASE_URL
    : authMethod === 'oauth_grok'
      ? GROK_SUBSCRIPTION_BASE_URL
      : (config.baseUrl || descriptor.defaults.baseUrl);
  const apiKey = config.apiKey || '';
  const endpoint = endpointForWire(baseUrl, wire, { model: config.model, apiKey, authMethod, stream: true });
  const accountId = config.accountId || null;
  const customHeaders = config.customHeaders || {};
  validateCustomHeaders(customHeaders);
  const headers = mergeHeaders(
    requiredHeadersFor({
      wire,
      apiKey,
      accountId,
      authMethod,
      oauthProjectId: config.oauthProjectId,
    }),
    descriptor.headers,
    descriptor.customHeaders,
    customHeaders,
  );

  const capabilities = structuredClone(descriptor.capabilities || {});
  if (config.supportsReasoning !== undefined) {
    capabilities.reasoning = {
      ...(capabilities.reasoning || {}),
      supported: Boolean(config.supportsReasoning),
    };
    if (!capabilities.reasoning.supported) capabilities.reasoning.paramStyle = 'none';
  }
  if (config.reasoningParamStyle) {
    capabilities.reasoning = {
      ...(capabilities.reasoning || {}),
      paramStyle: config.reasoningParamStyle,
      supported: config.reasoningParamStyle !== 'none',
    };
  }
  const reasoningEffortMap = normalizeReasoningEffortMap(config.reasoningEffortMap);
  if (reasoningEffortMap) {
    capabilities.reasoning = {
      ...(capabilities.reasoning || {}),
      effortMap: reasoningEffortMap,
    };
  }
  if (config.supportsPromptCaching !== undefined) {
    capabilities.promptCache = Boolean(config.supportsPromptCaching);
  }
  if (config.supportsVision !== undefined) {
    capabilities.vision = Boolean(config.supportsVision);
  }

  return {
    channelId,
    authMethod,
    wire,
    baseUrl,
    endpoint,
    testEndpoint: endpointForWire(baseUrl, wire, { model: config.model, apiKey, authMethod, stream: false }),
    headers,
    descriptor,
    capabilities,
    legacyProvider: legacyProviderForWire(wire),
    reasoningParamStyle: capabilities.reasoning?.paramStyle || 'none',
    reasoningEffortMap: capabilities.reasoning?.effortMap || undefined,
    reasoningEffortLevels: capabilities.reasoning?.effortLevels || undefined,
    supportsReasoning: Boolean(capabilities.reasoning?.supported),
    supportsPromptCaching: Boolean(capabilities.promptCache),
  };
}
