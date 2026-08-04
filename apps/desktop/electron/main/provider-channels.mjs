import { buildClaudeCliIdentityHeaders } from './provider-adapters/anthropic-cli-identity.mjs';

export const CHATGPT_SUBSCRIPTION_NAME = 'ChatGPT 订阅';
export const CHATGPT_SUBSCRIPTION_BASE_URL = 'https://chatgpt.com/backend-api/codex';
export const GROK_OFFICIAL_NAME = 'Grok 官方';
export const GROK_SUBSCRIPTION_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
export const GEMINI_OAUTH_NAME = 'Gemini OAuth';
export const GEMINI_CODE_ASSIST_BASE_URL = 'https://cloudcode-pa.googleapis.com';
export const QODER_PRIVATE_NAME = 'Qoder（本机 CLI）';

export const CHANNEL_IDS = {
  OPENAI: 'openai',
  ANTHROPIC: 'anthropic',
  DEEPSEEK: 'deepseek',
  GLM_CODING_PLAN_CN: 'glm-coding-plan-cn',
  GLM_CODING_PLAN_GLOBAL: 'glm-coding-plan-global',
  KIMI_CODING_PLAN: 'kimi-coding-plan',
  MOONSHOT: 'moonshot',
  MINIMAX_CN: 'minimax-cn',
  MINIMAX_GLOBAL: 'minimax-global',
  VOLCENGINE_ARK: 'volcengine-ark',
  XIAOMI_MIMO: 'xiaomi-mimo',
  XIAOMI_MIMO_TOKEN_PLAN: 'xiaomi-mimo-token-plan',
  ALIYUN_BAILIAN: 'aliyun-bailian',
  OPENCODE_GO_OPENAI: 'opencode-go-openai',
  OPENCODE_GO_ANTHROPIC: 'opencode-go-anthropic',
  OPENAI_COMPATIBLE: 'openai-compatible',
  ANTHROPIC_COMPATIBLE: 'anthropic-compatible',
  GOOGLE_AI: 'google-ai',
  GROK: 'grok',
  QODER: 'qoder',
};

/**
 * DeepSeek 官方 Anthropic 兼容入口。
 * 文档: https://api-docs.deepseek.com/zh-cn/guides/anthropic_api
 * 思考契约: thinking.type enabled/disabled + output_config.effort low/high/max
 */
export const DEEPSEEK_ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic';
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-chat';

/** GLM Coding Plan Anthropic-compatible endpoints (region-specific; keys are not interchangeable). */
export const GLM_CODING_PLAN_CN_BASE_URL = 'https://open.bigmodel.cn/api/anthropic';
export const GLM_CODING_PLAN_GLOBAL_BASE_URL = 'https://api.z.ai/api/anthropic';
export const GLM_CODING_PLAN_DEFAULT_MODEL = 'glm-4.7';

/** Moonshot / Kimi OpenAI-compatible endpoints (CN vs international). */
export const MOONSHOT_CN_BASE_URL = 'https://api.moonshot.cn/v1';
export const MOONSHOT_GLOBAL_BASE_URL = 'https://api.moonshot.ai/v1';
export const KIMI_CODING_PLAN_DEFAULT_MODEL = 'kimi-k2.7-code';
export const MOONSHOT_DEFAULT_MODEL = 'kimi-k3';

/** MiniMax Coding / Token Plan Anthropic-compatible endpoints (region-specific). */
export const MINIMAX_CN_ANTHROPIC_BASE_URL = 'https://api.minimaxi.com/anthropic';
export const MINIMAX_GLOBAL_ANTHROPIC_BASE_URL = 'https://api.minimax.io/anthropic';
export const MINIMAX_DEFAULT_MODEL = 'MiniMax-M3';

/** Volcengine Ark (Coding Plan / OpenAI-compatible inference). */
export const VOLCENGINE_ARK_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
/** Placeholder — replace with your Ark endpoint ID or model name from console. */
export const VOLCENGINE_ARK_DEFAULT_MODEL = 'doubao-seed-1-6';

/** Xiaomi MiMo — pay-as-you-go vs Token Plan use different hosts and key prefixes. */
export const XIAOMI_MIMO_BASE_URL = 'https://api.xiaomimimo.com/v1';
export const XIAOMI_MIMO_TOKEN_PLAN_BASE_URL = 'https://token-plan-cn.xiaomimimo.com/v1';
export const XIAOMI_MIMO_DEFAULT_MODEL = 'mimo-v2.5-pro';

/** Aliyun Bailian Coding Plan (dedicated coding.dashscope host + sk-sp- key). */
export const ALIYUN_BAILIAN_CODING_BASE_URL = 'https://coding.dashscope.aliyuncs.com/v1';
export const ALIYUN_BAILIAN_DEFAULT_MODEL = 'qwen3-coder-plus';

/**
 * OpenCode Zen / Go subscription endpoints.
 * GPT family uses Responses API; Claude family uses Anthropic Messages.
 * @see https://opencode.ai/docs/zen
 */
export const OPENCODE_ZEN_OPENAI_BASE_URL = 'https://opencode.ai/zen/v1';
export const OPENCODE_ZEN_ANTHROPIC_BASE_URL = 'https://opencode.ai/zen';
export const OPENCODE_ZEN_OPENAI_DEFAULT_MODEL = 'gpt-5.5';
export const OPENCODE_ZEN_ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-4-5';
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
  [CHANNEL_IDS.DEEPSEEK]: {
    id: CHANNEL_IDS.DEEPSEEK,
    label: 'DeepSeek 官方',
    // 官方 Anthropic 兼容 API：base_url + /v1/messages，思考走 thinking + output_config.effort。
    legacyProvider: 'anthropic',
    defaultWire: 'anthropic-messages',
    allowedWires: ['anthropic-messages'],
    authMethods: { api_key: { wire: 'anthropic-messages' } },
    defaults: { baseUrl: DEEPSEEK_ANTHROPIC_BASE_URL, model: DEEPSEEK_DEFAULT_MODEL },
    capabilities: {
      reasoning: {
        supported: true,
        // DeepSeek Anthropic: thinking.enabled/disabled + output_config.effort(low/high/max)
        // 与 Claude adaptive 不同：不能发 type:'adaptive'，off 必须显式 disabled。
        paramStyle: 'anthropic-enabled-output-effort',
        // 官方档位 low/high/max；xhigh 官方映射到 high；default 对齐官方默认 high。
        effortLevels: ['off', 'low', 'high', 'max'],
        defaultEffort: 'high',
        effortMap: {
          off: 'disabled',
          low: 'low',
          medium: 'high',
          default: 'high',
          high: 'high',
          xhigh: 'high',
          max: 'max',
        },
      },
      promptCache: true,
      vision: false,
      toolUse: true,
      temperature: true,
    },
  },
  [CHANNEL_IDS.GLM_CODING_PLAN_CN]: {
    id: CHANNEL_IDS.GLM_CODING_PLAN_CN,
    label: 'GLM Coding Plan 国区',
    legacyProvider: 'anthropic',
    defaultWire: 'anthropic-messages',
    allowedWires: ['anthropic-messages'],
    authMethods: { api_key: { wire: 'anthropic-messages' } },
    defaults: {
      baseUrl: GLM_CODING_PLAN_CN_BASE_URL,
      model: GLM_CODING_PLAN_DEFAULT_MODEL,
    },
    headers: buildClaudeCliIdentityHeaders(),
    capabilities: {
      reasoning: {
        supported: true,
        paramStyle: 'anthropic-enabled-budget',
        effortLevels: ['off', 'low', 'default', 'high', 'xhigh'],
        defaultEffort: 'default',
      },
      promptCache: true,
      vision: false,
      toolUse: true,
      temperature: true,
    },
  },
  [CHANNEL_IDS.GLM_CODING_PLAN_GLOBAL]: {
    id: CHANNEL_IDS.GLM_CODING_PLAN_GLOBAL,
    label: 'GLM Coding Plan 国际区',
    legacyProvider: 'anthropic',
    defaultWire: 'anthropic-messages',
    allowedWires: ['anthropic-messages'],
    authMethods: { api_key: { wire: 'anthropic-messages' } },
    defaults: {
      baseUrl: GLM_CODING_PLAN_GLOBAL_BASE_URL,
      model: GLM_CODING_PLAN_DEFAULT_MODEL,
    },
    headers: buildClaudeCliIdentityHeaders(),
    capabilities: {
      reasoning: {
        supported: true,
        paramStyle: 'anthropic-enabled-budget',
        effortLevels: ['off', 'low', 'default', 'high', 'xhigh'],
        defaultEffort: 'default',
      },
      promptCache: true,
      vision: false,
      toolUse: true,
      temperature: true,
    },
  },
  [CHANNEL_IDS.KIMI_CODING_PLAN]: {
    id: CHANNEL_IDS.KIMI_CODING_PLAN,
    label: 'Kimi Coding Plan',
    legacyProvider: 'openai',
    defaultWire: 'openai-chat',
    allowedWires: ['openai-chat'],
    authMethods: { api_key: { wire: 'openai-chat' } },
    defaults: {
      baseUrl: MOONSHOT_CN_BASE_URL,
      model: KIMI_CODING_PLAN_DEFAULT_MODEL,
    },
    capabilities: {
      reasoning: {
        supported: true,
        paramStyle: 'none',
        effortLevels: ['off', 'default'],
        defaultEffort: 'default',
      },
      promptCache: true,
      vision: false,
      toolUse: true,
      temperature: true,
    },
  },
  [CHANNEL_IDS.MOONSHOT]: {
    id: CHANNEL_IDS.MOONSHOT,
    label: 'Moonshot',
    legacyProvider: 'openai',
    defaultWire: 'openai-chat',
    allowedWires: ['openai-chat'],
    authMethods: { api_key: { wire: 'openai-chat' } },
    defaults: {
      baseUrl: MOONSHOT_CN_BASE_URL,
      model: MOONSHOT_DEFAULT_MODEL,
    },
    capabilities: {
      reasoning: {
        supported: true,
        paramStyle: 'none',
        effortLevels: ['off', 'default'],
        defaultEffort: 'default',
      },
      promptCache: true,
      vision: true,
      toolUse: true,
      temperature: true,
    },
  },
  [CHANNEL_IDS.MINIMAX_CN]: {
    id: CHANNEL_IDS.MINIMAX_CN,
    label: 'MiniMax（国区）',
    legacyProvider: 'anthropic',
    defaultWire: 'anthropic-messages',
    allowedWires: ['anthropic-messages'],
    authMethods: { api_key: { wire: 'anthropic-messages' } },
    defaults: {
      baseUrl: MINIMAX_CN_ANTHROPIC_BASE_URL,
      model: MINIMAX_DEFAULT_MODEL,
    },
    headers: buildClaudeCliIdentityHeaders(),
    capabilities: {
      reasoning: {
        supported: true,
        paramStyle: 'anthropic-enabled-budget',
        effortLevels: ['off', 'low', 'default', 'high', 'xhigh'],
        defaultEffort: 'default',
      },
      promptCache: true,
      vision: false,
      toolUse: true,
      temperature: true,
    },
  },
  [CHANNEL_IDS.MINIMAX_GLOBAL]: {
    id: CHANNEL_IDS.MINIMAX_GLOBAL,
    label: 'MiniMax（国际区）',
    legacyProvider: 'anthropic',
    defaultWire: 'anthropic-messages',
    allowedWires: ['anthropic-messages'],
    authMethods: { api_key: { wire: 'anthropic-messages' } },
    defaults: {
      baseUrl: MINIMAX_GLOBAL_ANTHROPIC_BASE_URL,
      model: MINIMAX_DEFAULT_MODEL,
    },
    headers: buildClaudeCliIdentityHeaders(),
    capabilities: {
      reasoning: {
        supported: true,
        paramStyle: 'anthropic-enabled-budget',
        effortLevels: ['off', 'low', 'default', 'high', 'xhigh'],
        defaultEffort: 'default',
      },
      promptCache: true,
      vision: false,
      toolUse: true,
      temperature: true,
    },
  },
  [CHANNEL_IDS.VOLCENGINE_ARK]: {
    id: CHANNEL_IDS.VOLCENGINE_ARK,
    label: 'Volcengine Ark',
    legacyProvider: 'openai',
    defaultWire: 'openai-chat',
    allowedWires: ['openai-chat'],
    authMethods: { api_key: { wire: 'openai-chat' } },
    defaults: {
      baseUrl: VOLCENGINE_ARK_BASE_URL,
      model: VOLCENGINE_ARK_DEFAULT_MODEL,
    },
    capabilities: {
      reasoning: {
        supported: true,
        paramStyle: 'none',
        effortLevels: ['off', 'default'],
        defaultEffort: 'default',
      },
      promptCache: true,
      vision: true,
      toolUse: true,
      temperature: true,
    },
  },
  [CHANNEL_IDS.XIAOMI_MIMO]: {
    id: CHANNEL_IDS.XIAOMI_MIMO,
    label: 'Xiaomi MiMo',
    legacyProvider: 'openai',
    defaultWire: 'openai-chat',
    allowedWires: ['openai-chat'],
    authMethods: { api_key: { wire: 'openai-chat' } },
    defaults: {
      baseUrl: XIAOMI_MIMO_BASE_URL,
      model: XIAOMI_MIMO_DEFAULT_MODEL,
    },
    capabilities: {
      reasoning: {
        supported: true,
        paramStyle: 'none',
        effortLevels: ['off', 'default'],
        defaultEffort: 'default',
      },
      promptCache: true,
      vision: false,
      toolUse: true,
      temperature: true,
    },
  },
  [CHANNEL_IDS.XIAOMI_MIMO_TOKEN_PLAN]: {
    id: CHANNEL_IDS.XIAOMI_MIMO_TOKEN_PLAN,
    label: 'Xiaomi MiMo Token Plan',
    legacyProvider: 'openai',
    defaultWire: 'openai-chat',
    allowedWires: ['openai-chat'],
    authMethods: { api_key: { wire: 'openai-chat' } },
    defaults: {
      baseUrl: XIAOMI_MIMO_TOKEN_PLAN_BASE_URL,
      model: XIAOMI_MIMO_DEFAULT_MODEL,
    },
    capabilities: {
      reasoning: {
        supported: true,
        paramStyle: 'none',
        effortLevels: ['off', 'default'],
        defaultEffort: 'default',
      },
      promptCache: true,
      vision: false,
      toolUse: true,
      temperature: true,
    },
  },
  [CHANNEL_IDS.ALIYUN_BAILIAN]: {
    id: CHANNEL_IDS.ALIYUN_BAILIAN,
    label: 'Aliyun Bailian Coding Plan',
    legacyProvider: 'openai',
    defaultWire: 'openai-chat',
    allowedWires: ['openai-chat'],
    authMethods: { api_key: { wire: 'openai-chat' } },
    defaults: {
      baseUrl: ALIYUN_BAILIAN_CODING_BASE_URL,
      model: ALIYUN_BAILIAN_DEFAULT_MODEL,
    },
    capabilities: {
      reasoning: {
        supported: true,
        paramStyle: 'none',
        effortLevels: ['off', 'default'],
        defaultEffort: 'default',
      },
      promptCache: true,
      vision: true,
      toolUse: true,
      temperature: true,
    },
  },
  [CHANNEL_IDS.OPENCODE_GO_OPENAI]: {
    id: CHANNEL_IDS.OPENCODE_GO_OPENAI,
    label: 'OpenCode Go (OpenAI)',
    legacyProvider: 'openai',
    defaultWire: 'openai-responses',
    allowedWires: ['openai-responses'],
    authMethods: { api_key: { wire: 'openai-responses' } },
    defaults: {
      baseUrl: OPENCODE_ZEN_OPENAI_BASE_URL,
      model: OPENCODE_ZEN_OPENAI_DEFAULT_MODEL,
    },
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
  [CHANNEL_IDS.OPENCODE_GO_ANTHROPIC]: {
    id: CHANNEL_IDS.OPENCODE_GO_ANTHROPIC,
    label: 'OpenCode Go (Anthropic)',
    legacyProvider: 'anthropic',
    defaultWire: 'anthropic-messages',
    allowedWires: ['anthropic-messages'],
    authMethods: { api_key: { wire: 'anthropic-messages' } },
    defaults: {
      baseUrl: OPENCODE_ZEN_ANTHROPIC_BASE_URL,
      model: OPENCODE_ZEN_ANTHROPIC_DEFAULT_MODEL,
    },
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
    id: 'deepseek-api',
    brand: 'DeepSeek',
    title: 'DeepSeek',
    description: 'DeepSeek 官方 Anthropic 兼容 API（思考强度 low/high/max）',
    accessCategory: 'official_api',
    supportTier: 'verified',
    channelId: CHANNEL_IDS.DEEPSEEK,
    authMethod: 'api_key',
    legacyProvider: 'anthropic',
    defaultWire: 'anthropic-messages',
    defaults: {
      baseUrl: DEEPSEEK_ANTHROPIC_BASE_URL,
      model: DEEPSEEK_DEFAULT_MODEL,
      hideBaseUrlByDefault: true,
    },
    searchAliases: ['deepseek', '深度求索'],
    tags: ['官方 API', 'API Key', 'Anthropic 兼容'],
  },
  {
    id: 'glm-coding-plan-cn',
    brand: '智谱 GLM',
    title: 'GLM Coding Plan（国区）',
    description: '智谱 Coding Plan 国区 · open.bigmodel.cn Anthropic 兼容端点',
    accessCategory: 'third_party',
    supportTier: 'verified',
    channelId: CHANNEL_IDS.GLM_CODING_PLAN_CN,
    authMethod: 'api_key',
    legacyProvider: 'anthropic',
    defaultWire: 'anthropic-messages',
    defaults: {
      baseUrl: GLM_CODING_PLAN_CN_BASE_URL,
      model: GLM_CODING_PLAN_DEFAULT_MODEL,
      hideBaseUrlByDefault: true,
    },
    searchAliases: ['glm', 'zhipu', '智谱', 'coding plan', 'bigmodel', '国区'],
    tags: ['Coding Plan', '国区'],
    knownLimitations: ['套餐模型范围与额度以智谱 Coding Plan 为准；国区与国际区 Key/端点不可混用'],
  },
  {
    id: 'glm-coding-plan-global',
    brand: '智谱 GLM',
    title: 'GLM Coding Plan（国际区）',
    description: 'GLM Coding Plan 国际区 · api.z.ai Anthropic 兼容端点',
    accessCategory: 'third_party',
    supportTier: 'verified',
    channelId: CHANNEL_IDS.GLM_CODING_PLAN_GLOBAL,
    authMethod: 'api_key',
    legacyProvider: 'anthropic',
    defaultWire: 'anthropic-messages',
    defaults: {
      baseUrl: GLM_CODING_PLAN_GLOBAL_BASE_URL,
      model: GLM_CODING_PLAN_DEFAULT_MODEL,
      hideBaseUrlByDefault: true,
    },
    searchAliases: ['glm', 'zhipu', 'z.ai', 'coding plan', 'international', '国际区'],
    tags: ['Coding Plan', '国际区'],
    knownLimitations: ['套餐模型范围与额度以 GLM Coding Plan 为准；国区与国际区 Key/端点不可混用'],
  },
  {
    id: 'kimi-coding-plan',
    brand: 'Kimi',
    title: 'Kimi Coding Plan',
    description: 'Kimi 编程计划 API · 默认 Coding 模型（国区 moonshot.cn）',
    accessCategory: 'third_party',
    supportTier: 'verified',
    channelId: CHANNEL_IDS.KIMI_CODING_PLAN,
    authMethod: 'api_key',
    legacyProvider: 'openai',
    defaultWire: 'openai-chat',
    defaults: {
      baseUrl: MOONSHOT_CN_BASE_URL,
      model: KIMI_CODING_PLAN_DEFAULT_MODEL,
      hideBaseUrlByDefault: true,
    },
    searchAliases: ['kimi', 'coding plan', 'moonshot', 'k2.7', '编程计划'],
    tags: ['Coding Plan', '国区'],
    knownLimitations: [
      'OpenAI 兼容；国际用户可改 baseUrl 为 https://api.moonshot.ai/v1',
      '编程场景也可选用 kimi-k2.7-code-highspeed / kimi-k3',
    ],
  },
  {
    id: 'moonshot-api',
    brand: 'Moonshot',
    title: 'Moonshot',
    description: '月之暗面 API · OpenAI 兼容（国区 moonshot.cn）',
    accessCategory: 'third_party',
    supportTier: 'verified',
    channelId: CHANNEL_IDS.MOONSHOT,
    authMethod: 'api_key',
    legacyProvider: 'openai',
    defaultWire: 'openai-chat',
    defaults: {
      baseUrl: MOONSHOT_CN_BASE_URL,
      model: MOONSHOT_DEFAULT_MODEL,
      hideBaseUrlByDefault: true,
    },
    searchAliases: ['moonshot', 'kimi', '月之暗面', 'k3'],
    tags: ['套餐/API', '国区'],
    knownLimitations: [
      'OpenAI 兼容；国际用户可改 baseUrl 为 https://api.moonshot.ai/v1',
    ],
  },
  {
    id: 'minimax-cn',
    brand: 'MiniMax',
    title: 'MiniMax（CN）',
    description: 'MiniMax 编程套餐 — 中国区（Anthropic 兼容）',
    accessCategory: 'third_party',
    supportTier: 'verified',
    channelId: CHANNEL_IDS.MINIMAX_CN,
    authMethod: 'api_key',
    legacyProvider: 'anthropic',
    defaultWire: 'anthropic-messages',
    defaults: {
      baseUrl: MINIMAX_CN_ANTHROPIC_BASE_URL,
      model: MINIMAX_DEFAULT_MODEL,
      hideBaseUrlByDefault: true,
    },
    searchAliases: ['minimax', 'minimaxi', '国区', 'coding', 'token plan'],
    tags: ['Coding Plan', '国区'],
    knownLimitations: [
      '国区与国际区 Key/端点不可混用',
      'Token Plan 请使用订阅 Key；按量付费使用普通 API Key',
    ],
  },
  {
    id: 'minimax-global',
    brand: 'MiniMax',
    title: 'MiniMax（Global）',
    description: 'MiniMax 编程套餐 — 国际区（Anthropic 兼容）',
    accessCategory: 'third_party',
    supportTier: 'verified',
    channelId: CHANNEL_IDS.MINIMAX_GLOBAL,
    authMethod: 'api_key',
    legacyProvider: 'anthropic',
    defaultWire: 'anthropic-messages',
    defaults: {
      baseUrl: MINIMAX_GLOBAL_ANTHROPIC_BASE_URL,
      model: MINIMAX_DEFAULT_MODEL,
      hideBaseUrlByDefault: true,
    },
    searchAliases: ['minimax', 'global', 'international', 'coding', 'token plan'],
    tags: ['Coding Plan', '国际区'],
    knownLimitations: [
      '国区与国际区 Key/端点不可混用',
      'Token Plan 请使用订阅 Key；按量付费使用普通 API Key',
    ],
  },
  {
    id: 'volcengine-ark',
    brand: 'Volcengine',
    title: 'Volcengine Ark',
    description: '字节火山方舟 Coding Plan — 豆包、GLM、DeepSeek 等',
    accessCategory: 'third_party',
    supportTier: 'verified',
    channelId: CHANNEL_IDS.VOLCENGINE_ARK,
    authMethod: 'api_key',
    legacyProvider: 'openai',
    defaultWire: 'openai-chat',
    defaults: {
      baseUrl: VOLCENGINE_ARK_BASE_URL,
      model: VOLCENGINE_ARK_DEFAULT_MODEL,
      hideBaseUrlByDefault: true,
    },
    searchAliases: ['volcengine', 'ark', '火山', '方舟', 'doubao', '豆包', 'coding plan'],
    tags: ['Coding Plan'],
    knownLimitations: [
      'model 请填写方舟控制台中的推理接入点 ID 或模型名',
      'Coding Plan 请使用套餐对应的个人版 API Key',
    ],
  },
  {
    id: 'xiaomi-mimo',
    brand: 'Xiaomi MiMo',
    title: 'Xiaomi MiMo',
    description: '小米 MiMo 按量付费 — MiMo-V2.5-Pro',
    accessCategory: 'third_party',
    supportTier: 'verified',
    channelId: CHANNEL_IDS.XIAOMI_MIMO,
    authMethod: 'api_key',
    legacyProvider: 'openai',
    defaultWire: 'openai-chat',
    defaults: {
      baseUrl: XIAOMI_MIMO_BASE_URL,
      model: XIAOMI_MIMO_DEFAULT_MODEL,
      hideBaseUrlByDefault: true,
    },
    searchAliases: ['xiaomi', 'mimo', '小米', '按量'],
    tags: ['按量付费'],
    knownLimitations: [
      '按量付费 Key 前缀 sk-；勿与 Token Plan 端点混用',
      '也支持 Anthropic 兼容：https://api.xiaomimimo.com/anthropic',
    ],
  },
  {
    id: 'xiaomi-mimo-token-plan',
    brand: 'Xiaomi MiMo',
    title: 'Xiaomi MiMo Token Plan',
    description: '小米 MiMo Token Plan 订阅套餐 — MiMo-V2.5-Pro',
    accessCategory: 'third_party',
    supportTier: 'verified',
    channelId: CHANNEL_IDS.XIAOMI_MIMO_TOKEN_PLAN,
    authMethod: 'api_key',
    legacyProvider: 'openai',
    defaultWire: 'openai-chat',
    defaults: {
      baseUrl: XIAOMI_MIMO_TOKEN_PLAN_BASE_URL,
      model: XIAOMI_MIMO_DEFAULT_MODEL,
      hideBaseUrlByDefault: true,
    },
    searchAliases: ['xiaomi', 'mimo', 'token plan', '小米', '订阅'],
    tags: ['Token Plan'],
    knownLimitations: [
      'Token Plan Key 前缀 tp-；Base URL 与按量付费不同',
      '也支持 Anthropic 兼容：https://token-plan-cn.xiaomimimo.com/anthropic',
    ],
  },
  {
    id: 'aliyun-bailian',
    brand: 'Aliyun Bailian',
    title: 'Aliyun Bailian',
    description: '阿里云百炼 Coding Plan — 通义千问、GLM、Kimi 等',
    accessCategory: 'third_party',
    supportTier: 'verified',
    channelId: CHANNEL_IDS.ALIYUN_BAILIAN,
    authMethod: 'api_key',
    legacyProvider: 'openai',
    defaultWire: 'openai-chat',
    defaults: {
      baseUrl: ALIYUN_BAILIAN_CODING_BASE_URL,
      model: ALIYUN_BAILIAN_DEFAULT_MODEL,
      hideBaseUrlByDefault: true,
    },
    searchAliases: ['bailian', 'aliyun', 'dashscope', '百炼', 'coding plan', 'qwen'],
    tags: ['Coding Plan'],
    knownLimitations: [
      '必须使用 Coding Plan 专属 API Key（sk-sp-）与 coding.dashscope 端点',
      '与按量计费 sk- / dashscope.aliyuncs.com 不互通',
      '也支持 Anthropic 兼容：https://coding.dashscope.aliyuncs.com/apps/anthropic',
    ],
  },
  {
    id: 'opencode-go-openai',
    brand: 'OpenCode',
    title: 'OpenCode Go (OpenAI)',
    description: 'OpenCode Zen Go 订阅 — OpenAI 兼容模型（用 Responses API）',
    accessCategory: 'third_party',
    supportTier: 'verified',
    channelId: CHANNEL_IDS.OPENCODE_GO_OPENAI,
    authMethod: 'api_key',
    legacyProvider: 'openai',
    defaultWire: 'openai-responses',
    defaults: {
      baseUrl: OPENCODE_ZEN_OPENAI_BASE_URL,
      model: OPENCODE_ZEN_OPENAI_DEFAULT_MODEL,
      hideBaseUrlByDefault: true,
    },
    searchAliases: ['opencode', 'zen', 'go', 'gpt'],
    tags: ['订阅', 'OpenAI'],
    knownLimitations: [
      'GPT 系列走 Responses API：https://opencode.ai/zen/v1/responses',
      '在 opencode.ai 登录后复制 API Key；模型列表见 /zen/v1/models',
    ],
  },
  {
    id: 'opencode-go-anthropic',
    brand: 'OpenCode',
    title: 'OpenCode Go (Anthropic)',
    description: 'OpenCode Zen Go 订阅 — Anthropic Messages 协议模型',
    accessCategory: 'third_party',
    supportTier: 'verified',
    channelId: CHANNEL_IDS.OPENCODE_GO_ANTHROPIC,
    authMethod: 'api_key',
    legacyProvider: 'anthropic',
    defaultWire: 'anthropic-messages',
    defaults: {
      baseUrl: OPENCODE_ZEN_ANTHROPIC_BASE_URL,
      model: OPENCODE_ZEN_ANTHROPIC_DEFAULT_MODEL,
      hideBaseUrlByDefault: true,
    },
    searchAliases: ['opencode', 'zen', 'go', 'claude', 'anthropic'],
    tags: ['订阅', 'Anthropic'],
    knownLimitations: [
      'Claude 系列走 Anthropic Messages：https://opencode.ai/zen/v1/messages',
      '与 OpenAI 卡共用 Zen API Key，但 wire/baseUrl 不同',
    ],
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
    description: '本机已登录的 Qoder CLI',
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
