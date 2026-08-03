import { buildClaudeCliIdentityHeaders } from './provider-adapters/anthropic-cli-identity.mjs';

export const CHATGPT_SUBSCRIPTION_NAME = 'ChatGPT 订阅';
export const CHATGPT_SUBSCRIPTION_BASE_URL = 'https://chatgpt.com/backend-api/codex';
export const GROK_OFFICIAL_NAME = 'Grok 官方';
export const GROK_SUBSCRIPTION_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
export const GEMINI_OAUTH_NAME = 'Gemini OAuth';
export const GEMINI_CODE_ASSIST_BASE_URL = 'https://cloudcode-pa.googleapis.com';
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
        effortLevels: ['off', 'low', 'default', 'high', 'xhigh'],
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
        effortLevels: ['off', 'low', 'default', 'high', 'xhigh'],
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
        effortLevels: ['off', 'low', 'default', 'high', 'xhigh'],
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
        effortLevels: ['off', 'low', 'default', 'high', 'xhigh'],
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
    defaults: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-pro' },
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
    defaultWire: 'openai-responses',
    allowedWires: ['openai-responses'],
    authMethods: { oauth_grok: { wire: 'openai-responses' } },
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
        // Grok 4.5：仅 low/medium/high，默认 high，不可关闭 Thinking。
        // effortMap 兜底把 UI 历史 default/off 投影为 high，避免编码层落到 OpenAI 通用 medium。
        effortLevels: ['low', 'medium', 'high'],
        defaultEffort: 'high',
        effortMap: {
          off: 'high',
          low: 'low',
          medium: 'medium',
          default: 'high',
          high: 'high',
        },
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

/**
 * P0 服务模板注册表：用户发现入口，不等于 channel 枚举。
 * 同一 channel 可对应多个模板（例如 OpenAI API Key 与 ChatGPT 订阅）。
 */
const SERVICE_TEMPLATES = [
  {
    id: 'openai-api',
    brand: 'OpenAI',
    title: 'OpenAI',
    description: '官方 API Key 直连 · 无需订阅登录',
    accessCategory: 'official_api',
    supportTier: 'native',
    channelId: CHANNEL_IDS.OPENAI,
    authMethod: 'api_key',
    legacyProvider: 'openai',
    defaultWire: 'openai-chat',
    defaults: {
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      hideBaseUrlByDefault: true,
    },
    searchAliases: ['openai', 'gpt', 'chatgpt api'],
    tags: ['原生适配', 'API Key'],
  },
  {
    id: 'openai-chatgpt',
    brand: 'OpenAI',
    title: 'ChatGPT 订阅 / Codex 账号',
    description: '使用 ChatGPT Plus/Pro 订阅登录，无需 API Key',
    accessCategory: 'oauth',
    supportTier: 'native',
    channelId: CHANNEL_IDS.OPENAI,
    authMethod: 'oauth_chatgpt',
    legacyProvider: 'openai',
    defaultWire: 'openai-responses',
    defaults: {
      baseUrl: CHATGPT_SUBSCRIPTION_BASE_URL,
      model: 'gpt-5.3-codex',
      hideBaseUrlByDefault: true,
    },
    searchAliases: ['chatgpt', 'codex', 'subscription', '订阅'],
    tags: ['授权登录', '原生适配'],
  },
  {
    id: 'anthropic-api',
    brand: 'Anthropic',
    title: 'Anthropic',
    description: 'Anthropic 官方 API',
    accessCategory: 'official_api',
    supportTier: 'native',
    channelId: CHANNEL_IDS.ANTHROPIC,
    authMethod: 'api_key',
    legacyProvider: 'anthropic',
    defaultWire: 'anthropic-messages',
    defaults: {
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-20250514',
      hideBaseUrlByDefault: true,
    },
    searchAliases: ['claude', 'anthropic'],
    tags: ['原生适配', 'API Key'],
  },
  {
    id: 'google-ai-api',
    brand: 'Google',
    title: 'Google AI / Gemini',
    description: 'Gemini 官方 API Key',
    accessCategory: 'official_api',
    supportTier: 'verified',
    channelId: CHANNEL_IDS.GOOGLE_AI,
    authMethod: 'api_key',
    legacyProvider: 'openai',
    defaultWire: 'gemini',
    defaults: {
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-2.5-pro',
      hideBaseUrlByDefault: true,
    },
    searchAliases: ['gemini', 'google', 'google ai'],
    tags: ['验证兼容', 'API Key'],
  },
  {
    id: 'google-oauth',
    brand: 'Google',
    title: 'Gemini OAuth',
    description: '使用 Google 账号授权登录',
    accessCategory: 'oauth',
    supportTier: 'verified',
    channelId: CHANNEL_IDS.GOOGLE_AI,
    authMethod: 'oauth_google',
    legacyProvider: 'openai',
    defaultWire: 'gemini',
    defaults: {
      baseUrl: GEMINI_CODE_ASSIST_BASE_URL,
      model: 'gemini-2.5-pro',
      hideBaseUrlByDefault: true,
    },
    searchAliases: ['gemini oauth', 'google login'],
    tags: ['授权登录'],
  },
  {
    id: 'grok-oauth',
    brand: 'xAI',
    title: GROK_OFFICIAL_NAME,
    description: '登录 Grok 账号使用官方订阅通道',
    accessCategory: 'oauth',
    supportTier: 'verified',
    channelId: CHANNEL_IDS.GROK,
    authMethod: 'oauth_grok',
    legacyProvider: 'openai',
    defaultWire: 'openai-chat',
    defaults: {
      baseUrl: GROK_SUBSCRIPTION_BASE_URL,
      model: 'grok-code',
      hideBaseUrlByDefault: true,
    },
    searchAliases: ['grok', 'xai'],
    tags: ['授权登录'],
  },
  {
    id: 'qoder-local',
    brand: 'Qoder',
    title: QODER_PRIVATE_NAME,
    description: '本机 / 私有 Qoder 接口',
    accessCategory: 'local',
    supportTier: 'verified',
    channelId: CHANNEL_IDS.QODER,
    authMethod: 'qoder_local_auth',
    legacyProvider: 'openai',
    defaultWire: 'qoder-private',
    defaults: {
      baseUrl: 'https://api2-v2.qoder.sh/model/v1',
      model: 'auto',
      hideBaseUrlByDefault: false,
    },
    searchAliases: ['qoder', 'local'],
    tags: ['本地 / 私有'],
  },
  {
    id: 'openai-compatible',
    brand: 'OpenAI Compatible',
    title: 'OpenAI 兼容',
    description: '自定义 OpenAI 兼容地址 · 不保证全部高级能力',
    accessCategory: 'custom_compatible',
    supportTier: 'custom',
    channelId: CHANNEL_IDS.OPENAI_COMPATIBLE,
    authMethod: 'api_key',
    legacyProvider: 'openai',
    defaultWire: 'openai-chat',
    defaults: {
      baseUrl: '',
      model: 'gpt-4o',
      hideBaseUrlByDefault: false,
    },
    searchAliases: ['compatible', '兼容', 'gateway', '中转'],
    tags: ['自定义兼容'],
    knownLimitations: ['只验证当前请求链路，不保证完整官方能力'],
  },
  {
    id: 'anthropic-compatible',
    brand: 'Anthropic Compatible',
    title: 'Anthropic 兼容',
    description: '自定义 Anthropic 兼容地址 · 不保证全部高级能力',
    accessCategory: 'custom_compatible',
    supportTier: 'custom',
    channelId: CHANNEL_IDS.ANTHROPIC_COMPATIBLE,
    authMethod: 'api_key',
    legacyProvider: 'anthropic',
    defaultWire: 'anthropic-messages',
    defaults: {
      baseUrl: '',
      model: 'claude-sonnet-4-20250514',
      hideBaseUrlByDefault: false,
    },
    searchAliases: ['claude compatible', 'anthropic 兼容'],
    tags: ['自定义兼容'],
    knownLimitations: ['只验证当前请求链路，不保证完整官方能力'],
  },
];

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

export function listServiceTemplates() {
  return SERVICE_TEMPLATES.map((template) => structuredClone(template));
}

export function getServiceTemplate(templateId) {
  if (!templateId) return null;
  return SERVICE_TEMPLATES.find((item) => item.id === String(templateId)) ?? null;
}

/**
 * 按 channelId + authMethod 反查服务模板（旧配置迁移 / 回填）。
 */
export function resolveServiceTemplateId({ channelId, authMethod } = {}) {
  if (!channelId) return null;
  const method = authMethod || 'api_key';
  const exact = SERVICE_TEMPLATES.find(
    (item) => item.channelId === channelId && item.authMethod === method,
  );
  if (exact) return exact.id;
  const byChannel = SERVICE_TEMPLATES.find((item) => item.channelId === channelId);
  return byChannel?.id ?? null;
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
  if (!raw) return 'models/gemini-2.5-pro';
  return raw.startsWith('models/') ? raw : `models/${raw}`;
}

function endpointForWire(baseUrl, wire, { model, apiKey, authMethod, stream = true } = {}) {
  const root = String(baseUrl || '').replace(/\/+$/, '');
  if (wire === 'qoder-private') return `${root}/chat/completions`;
  if (wire === 'anthropic-messages') return `${root}/v1/messages`;
  if (wire === 'openai-responses') return `${root}/responses`;
  if (wire === 'gemini') {
    // Gemini OAuth / Code Assist 对齐 gemini-cli：走 cloudcode-pa v1internal，
    // 而不是 generativelanguage.googleapis.com 的 models/{model}:streamGenerateContent。
    if (authMethod === 'oauth_google') {
      const action = stream ? 'streamGenerateContent' : 'generateContent';
      return `${root}/v1internal:${action}${stream ? '?alt=sse' : ''}`;
    }
    const method = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    const keyParam = !apiKey
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
      // Code Assist 只需要 Bearer；project 放在请求体 project 字段。
      // 不要加 x-goog-user-project：它会把请求路由到 GCP 项目配额，
      // 对个人 Code Assist project 常触发 SERVICE_DISABLED / cloudcode-pa 403。
      headers.Authorization = `Bearer ${apiKey}`;
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
      : authMethod === 'oauth_google'
        ? GEMINI_CODE_ASSIST_BASE_URL
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
    oauthProjectId: String(config.oauthProjectId || '').trim() || null,
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
    reasoningDefaultEffort: capabilities.reasoning?.defaultEffort || undefined,
    supportsReasoning: Boolean(capabilities.reasoning?.supported),
    supportsPromptCaching: Boolean(capabilities.promptCache),
  };
}
