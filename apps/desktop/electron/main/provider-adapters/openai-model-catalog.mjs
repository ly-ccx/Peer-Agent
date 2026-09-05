import { enrichModelsWithRegistry, fetchModelsDevRegistry } from './models-dev-registry.mjs';
import { fetchWithConnectionRecovery } from '../provider-transports/recovering-fetch.mjs';
import {
  DEEPSEEK_ANTHROPIC_BASE_URL,
  DEEPSEEK_OPENAI_BASE_URL,
} from '../provider-channels.mjs';

// OpenAI 订阅(ChatGPT OAuth)模型目录(ADR 28)。
//
// 端点事实(参考 cline / opencode 的订阅实现):
// - 订阅对话只走 https://chatgpt.com/backend-api/codex/responses。
// - 该 codex 平面**没有列模型接口**,可用模型是 codex 平面固定的 gpt-5.x 家族。
// - 历史上曾用订阅 token 去打 https://api.openai.com/v1/models(按量计费平面):
//   要么 401,要么(本机网络)直接 ECONNRESET,且即便成功也只会混进订阅用不了的
//   API-only 模型。因此**不再发起这次注定失败的请求**——内置清单即权威目录。
//
// 入参 tokens 形如 { access, accountId },仅用于登录态判定,不参与列模型。

// 订阅(codex 平面)权威模型清单。按"新→旧"排列,第一项即默认"最新"。
// label 用 ChatGPT 客户端展示名,id 用 codex 端点接受的小写标识。
const SUBSCRIPTION_CATALOG = [
  // GPT-6 Astra 官方能力与价格；ChatGPT OAuth 订阅上下文按产品约束沿用 272k。
  {
    id: 'gpt-6-astra',
    label: 'GPT-6 Astra',
    contextWindow: 272_000,
    maxOutputTokens: 128_000,
    inputPrice: 10,
    outputPrice: 50,
    cacheReadPrice: 1,
    supportsVision: true,
    supportsReasoning: true,
    supportsPromptCaching: true,
    reasoningEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    contextWindow: 272_000,
    maxOutputTokens: 128_000,
    inputPrice: 5,
    outputPrice: 30,
    cacheReadPrice: 0.5,
    longContextInputThreshold: 272_000,
    longContextInputPrice: 10,
    longContextCacheReadPrice: 1,
    longContextOutputPrice: 45,
    standardPricing: {
      shortContext: { inputPrice: 5, cacheReadPrice: 0.5, outputPrice: 30 },
      longContext: { inputPrice: 10, cacheReadPrice: 1, outputPrice: 45 },
      longContextInputThreshold: 272_000,
    },
  },
  // GPT-5.6 家族: codex 端点模型 id 为 gpt-5.6-{sol,terra,luna}。
  // Codex 原生强度包含 xhigh/max 等值；GPT-5.6 完整暴露五档，避免将 xhigh 与 max 压缩为同一产品档位。
  // ChatGPT OAuth 订阅可用上下文窗口为 272k tokens；价格与 cached-input 能力来自 OpenAI 模型目录。
  // 置于 gpt-5.5 之后:与 ChatGPT 客户端展示顺序一致,且不改变默认(仍为 gpt-5.5)。
  {
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    contextWindow: 272_000,
    maxOutputTokens: 128_000,
    inputPrice: 5,
    outputPrice: 30,
    cacheReadPrice: 0.5,
    supportsVision: true,
    supportsReasoning: true,
    supportsPromptCaching: true,
    reasoningEffortLevels: ['low', 'default', 'high', 'xhigh', 'max'],
  },
  {
    id: 'gpt-5.6-terra',
    label: 'GPT-5.6 Terra',
    contextWindow: 272_000,
    maxOutputTokens: 128_000,
    inputPrice: 2.5,
    outputPrice: 15,
    cacheReadPrice: 0.25,
    supportsVision: true,
    supportsReasoning: true,
    supportsPromptCaching: true,
    reasoningEffortLevels: ['low', 'default', 'high', 'xhigh', 'max'],
  },
  {
    id: 'gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    contextWindow: 272_000,
    maxOutputTokens: 128_000,
    inputPrice: 1,
    outputPrice: 6,
    cacheReadPrice: 0.1,
    supportsVision: true,
    supportsReasoning: true,
    supportsPromptCaching: true,
    reasoningEffortLevels: ['low', 'default', 'high', 'xhigh', 'max'],
  },
  {
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    contextWindow: 272_000,
    maxOutputTokens: 128_000,
    inputPrice: 2.5,
    outputPrice: 15,
    cacheReadPrice: 0.25,
    longContextInputThreshold: 272_000,
    longContextInputPrice: 5,
    longContextCacheReadPrice: 0.5,
    longContextOutputPrice: 22.5,
    standardPricing: {
      shortContext: { inputPrice: 2.5, cacheReadPrice: 0.25, outputPrice: 15 },
      longContext: { inputPrice: 5, cacheReadPrice: 0.5, outputPrice: 22.5 },
      longContextInputThreshold: 272_000,
    },
  },
  {
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4-Mini',
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    inputPrice: 0.75,
    outputPrice: 4.5,
    cacheReadPrice: 0.075,
  },
  { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3-Codex-Spark' },
];

// 订阅默认模型(新建订阅 / 迁移旧值时落到此)。
const DEFAULT_SUBSCRIPTION_MODEL = 'gpt-6-astra';

// 合法订阅模型 id 集合,用于迁移时判定旧值是否仍有效。
const SUBSCRIPTION_MODEL_IDS = new Set(SUBSCRIPTION_CATALOG.map((m) => m.id));
const SUBSCRIPTION_MODEL_METADATA = new Map(SUBSCRIPTION_CATALOG.map((m) => [m.id, m]));

// 向后兼容别名:历史调用/测试以 FALLBACK_MODELS 引用同一份清单。
const FALLBACK_MODELS = SUBSCRIPTION_CATALOG;

// DeepSeek 官方静态目录兜底。
// 事实: DeepSeek 的 Anthropic 兼容平面没有 /v1/models,模型目录只挂在
// OpenAI 兼容平面;目录远程失败(404/断网等)时用它兜底,官方仅此两款公开模型。
const DEEPSEEK_FALLBACK_CATALOG = Object.freeze([
  Object.freeze({
    id: 'deepseek-chat',
    label: 'DeepSeek Chat',
    contextWindow: 128_000,
    maxOutputTokens: 8_000,
  }),
  Object.freeze({
    id: 'deepseek-reasoner',
    label: 'DeepSeek Reasoner',
    contextWindow: 128_000,
    maxOutputTokens: 64_000,
  }),
]);

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined;
  const target = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

/**
 * DeepSeek Anthropic 平面没有 /v1/models。目录必须改写到 OpenAI 平面
 * (GET https://api.deepseek.com/models + Bearer)，即使调用方漏传 modelCatalog 覆盖。
 * 官方 Anthropic 根地址不受影响。
 */
function rewriteDeepSeekCatalogRequest({ baseUrl, wire, headers = {}, apiKey } = {}) {
  const root = String(baseUrl || '').replace(/\/+$/, '');
  if (!root) return { root, wire, headers: { ...headers } };
  const anthropicRoot = String(DEEPSEEK_ANTHROPIC_BASE_URL).replace(/\/+$/, '');
  const openaiRoot = String(DEEPSEEK_OPENAI_BASE_URL).replace(/\/+$/, '');
  const isDeepSeekAnthropic = root === anthropicRoot
    || root.startsWith(`${anthropicRoot}/`)
    || (/^https?:\/\/api\.deepseek\.com(?:\/|$)/i.test(root) && /\/anthropic(?:\/|$)/i.test(root));
  if (!isDeepSeekAnthropic) {
    return { root, wire, headers: { ...headers } };
  }
  const nextHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === 'x-api-key' || lower === 'anthropic-version' || lower === 'content-type') continue;
    nextHeaders[key] = value;
  }
  const existingAuth = headerValue(headers, 'authorization');
  const bearer = String(apiKey || '').trim()
    || String(existingAuth || '').replace(/^Bearer\s+/i, '').trim()
    || String(headerValue(headers, 'x-api-key') || '').trim();
  if (bearer) nextHeaders.Authorization = `Bearer ${bearer}`;
  return { root: openaiRoot, wire: 'openai-chat', headers: nextHeaders };
}

// 订阅 codex 端点仅允许权威内置目录中的模型。
function isSubscriptionUsableModel(id) {
  if (typeof id !== 'string') return false;
  return SUBSCRIPTION_MODEL_IDS.has(id);
}

// 仅保留对话相关模型(gpt / o 系列),过滤 embedding / tts / whisper / image 等。
function isChatModel(id) {
  if (typeof id !== 'string') return false;
  if (/embedding|whisper|tts|dall-e|image|moderation|audio|realtime|transcribe|search/i.test(id)) {
    return false;
  }
  return /^(gpt|o\d|chatgpt)/i.test(id);
}

// 按创建时间"新→旧"排序;无 created 的保持原序靠后。
function sortNewestFirst(models) {
  return [...models].sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
}

function getSubscriptionModelMetadata(id) {
  return SUBSCRIPTION_MODEL_METADATA.get(id) || null;
}

/**
 * 列出订阅(ChatGPT OAuth)可用模型。
 *
 * codex 订阅平面无列模型接口,内置清单即权威目录,因此直接返回静态清单,
 * source='builtin'(表示"内置权威目录",而非"远程失败后的兜底")。
 *
 * @param {{ access?: string, accountId?: string }} _tokens 仅占位,不参与列模型。
 * @returns {Promise<{ models: Array<{id:string,label:string}>, source: 'builtin' }>}
 */
export async function listSubscriptionModels(_tokens) {
  return { models: [...SUBSCRIPTION_CATALOG], source: 'builtin' };
}

// api_key provider 的对话模型判定(排除式)。
//
// 与 isChatModel(包含式,仅认 gpt/o 家族)不同:自带 API key 的 provider 可能是任意
// OpenAI 兼容后端(DeepSeek / Qwen / Kimi / 各类网关),模型 id 不遵循 openai 命名。
// 若沿用 isChatModel 会把 deepseek-chat、qwen-max 等全部误杀,故这里改为"排除已知
// 非对话类型(embedding / tts / 语音 / 图像 / 重排 等)",其余一律保留。
function isLikelyChatModel(id) {
  if (typeof id !== 'string' || !id) return false;
  return !/embedding|whisper|tts|dall-?e|image|vision-encoder|moderation|audio|realtime|transcribe|speech|rerank|guard|stable-?diffusion|clip|bge|reranker/i.test(id);
}

// 将不同 OpenAI 兼容 / Anthropic / Gemini 后端的列模型响应归一为 LlmModelInfo[]。
// - OpenAI 兼容: { data: [{ id, created }] }
// - Anthropic:   { data: [{ id, display_name, created_at }] }
// - Gemini:      { models: [{ name, displayName, inputTokenLimit, outputTokenLimit,
//                             supportedGenerationMethods }] }
function finiteCatalogNumber(...values) {
  const value = values.find((candidate) => typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0);
  return value;
}

function normalizeApiModelList(data, wire) {
  if (wire === 'gemini') {
    const arr = Array.isArray(data?.models) ? data.models : [];
    return arr
      .filter((m) => m?.name
        && (!Array.isArray(m.supportedGenerationMethods)
          || m.supportedGenerationMethods.includes('generateContent')))
      .map((m) => {
        const id = String(m.name).replace(/^models\//, '');
        return {
          id,
          label: m.displayName || id,
          contextWindow: m.inputTokenLimit,
          maxOutputTokens: m.outputTokenLimit,
        };
      });
  }
  const arr = Array.isArray(data?.data)
    ? data.data
    : (Array.isArray(data?.models) ? data.models : []);
  return arr
    .map((m) => {
      const id = String(m?.id ?? m?.name ?? '');
      const createdRaw = typeof m?.created === 'number'
        ? m.created
        : (typeof m?.created_at === 'string' ? Date.parse(m.created_at) / 1000 : undefined);
      const inputModalities = m?.architecture?.input_modalities ?? m?.supported_input_modalities;
      const pricing = m?.pricing ?? {};
      const contextWindow = finiteCatalogNumber(m?.contextWindow, m?.context_window, m?.context_length);
      const maxOutputTokens = finiteCatalogNumber(
        m?.maxOutputTokens,
        m?.max_output_tokens,
        m?.max_completion_tokens,
        m?.top_provider?.max_completion_tokens,
      );
      const inputPrice = finiteCatalogNumber(m?.inputPrice, pricing.input, pricing.prompt);
      const outputPrice = finiteCatalogNumber(m?.outputPrice, pricing.output, pricing.completion);
      const cacheReadPrice = finiteCatalogNumber(m?.cacheReadPrice, pricing.cache_read);
      const cacheWritePrice = finiteCatalogNumber(m?.cacheWritePrice, pricing.cache_write);
      const providerMetadataPresent = [contextWindow, maxOutputTokens, inputPrice, outputPrice, cacheReadPrice, cacheWritePrice]
        .some((value) => value !== undefined)
        || Array.isArray(inputModalities)
        || typeof m?.supportsReasoning === 'boolean'
        || typeof m?.reasoning === 'boolean';
      const model = {
        id,
        label: m?.display_name || m?.name || id,
      };
      const optionalFields = {
        created: Number.isFinite(createdRaw) ? createdRaw : undefined,
        contextWindow,
        maxOutputTokens,
        supportsVision: Array.isArray(inputModalities)
          ? inputModalities.map((value) => String(value).toLowerCase()).includes('image')
          : undefined,
        supportsReasoning: typeof m?.supportsReasoning === 'boolean'
          ? m.supportsReasoning
          : (typeof m?.reasoning === 'boolean' ? m.reasoning : undefined),
        inputPrice,
        outputPrice,
        cacheReadPrice,
        cacheWritePrice,
        metadataSource: providerMetadataPresent ? 'provider' : undefined,
        pricingSource: [inputPrice, outputPrice, cacheReadPrice, cacheWritePrice].some((value) => value !== undefined)
          ? 'provider'
          : undefined,
      };
      for (const [key, value] of Object.entries(optionalFields)) {
        if (value !== undefined) model[key] = value;
      }
      return model;
    })
    .filter((m) => m.id);
}

/**
 * 从自带 API key 的 provider 远程拉取可用模型(OpenAI /models 及兼容端点)。
 *
 * baseUrl 沿用 provider 已解析的根地址(与对话端点同源),按 wire 派生列模型路径:
 * - openai-chat / openai-responses: `${root}/models`(root 通常已含 /v1)
 * - anthropic-messages:             `${root}/v1/models`
 * - gemini:                         `${root}/models?key=<apiKey>`
 *
 * headers 复用对话请求的鉴权头(Authorization / x-api-key / anthropic-version 等),
 * 仅剔除只对 POST 有意义的 Content-Type。拉取成功返回 source='remote'。
 *
 * @param {{ baseUrl?: string, headers?: Record<string,string>, wire?: string,
 *           apiKey?: string, timeoutMs?: number, fetchImpl?: typeof fetch,
 *           modelCatalog?: { wire?: string, baseUrl?: string,
 *                            headers?: Record<string,string>, fallbackCatalog?: Array<{id:string,label:string}> } }} params
 * @returns {Promise<{ models: Array<{id:string,label:string}>, source: 'remote' }>}
 */
export async function listOpenAICompatibleModels({
  baseUrl,
  headers = {},
  wire,
  apiKey,
  timeoutMs = 15000,
  fetchImpl,
  registryFetchImpl,
  modelCatalog,
} = {}) {
  if (modelCatalog) {
    return listModelCatalogForChannel({
      baseUrl,
      wire,
      apiKey,
      timeoutMs,
      fetchImpl,
      registryFetchImpl,
      modelCatalog,
    });
  }
  const doFetch = fetchImpl || fetchWithConnectionRecovery;
  const rewritten = rewriteDeepSeekCatalogRequest({ baseUrl, wire, headers, apiKey });
  const root = rewritten.root;
  const catalogWire = rewritten.wire;
  if (!root) throw new Error('base_url_not_configured');

  const reqHeaders = { ...rewritten.headers };
  // GET 列模型无请求体,去掉只对 POST 有意义的 Content-Type,避免部分网关校验报错。
  for (const key of Object.keys(reqHeaders)) {
    if (key.toLowerCase() === 'content-type') delete reqHeaders[key];
  }

  let url;
  if (catalogWire === 'gemini') {
    url = `${root}/models${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ''}`;
  } else if (catalogWire === 'anthropic-messages') {
    url = `${root}/v1/models`;
  } else {
    url = `${root}/models`;
  }

  const res = await doFetch(url, {
    method: 'GET',
    headers: reqHeaders,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`models list failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const providerModels = sortNewestFirst(
    normalizeApiModelList(data, catalogWire).filter((m) => isLikelyChatModel(m.id)),
  );
  // A provider fetch mock should not accidentally become the registry transport too.
  // Production calls use global fetch; tests can opt in with registryFetchImpl.
  const registry = fetchImpl && !registryFetchImpl
    ? new Map()
    : await fetchModelsDevRegistry({ fetchImpl: registryFetchImpl });
  const models = enrichModelsWithRegistry(providerModels, registry);
  return { models, source: 'remote' };
}

/**
 * 渠道感知的模型目录统一入口。
 *
 * - requestConfig.modelCatalog 存在(渠道声明了目录平面覆盖,如 DeepSeek):
 *   用覆盖的 wire/baseUrl/headers 拉远程目录,失败时回退该渠道的静态目录
 *   (返回 source='fallback' 且保留 error 供诊断)。
 * - modelCatalog 不存在:与历史一致直接走 listOpenAICompatibleModels,
 *   失败原样抛错,不引入兜底。
 *
 * @param {{ baseUrl?: string, wire?: string, apiKey?: string, timeoutMs?: number,
 *           fetchImpl?: typeof fetch, registryFetchImpl?: typeof fetch,
 *           modelCatalog?: { channelId?: string, wire?: string, baseUrl?: string,
 *                            headers?: Record<string,string>,
 *                            fallbackCatalog?: Array<{id:string,label:string}> } }} requestConfig
 * @returns {Promise<{ models: Array<{id:string,label:string}>,
 *                     source: 'remote'|'fallback', error?: string }>}
 */
export async function listModelCatalogForChannel(requestConfig = {}) {
  const override = requestConfig.modelCatalog;
  if (!override) {
    return listOpenAICompatibleModels(requestConfig);
  }
  try {
    return await listOpenAICompatibleModels({
      ...requestConfig,
      wire: override.wire ?? requestConfig.wire,
      baseUrl: override.baseUrl ?? requestConfig.baseUrl,
      headers: override.headers ?? requestConfig.headers,
      modelCatalog: undefined,
    });
  } catch (error) {
    const fallbackCatalog = override.fallbackCatalog
      ?? (override.channelId === 'deepseek' ? DEEPSEEK_FALLBACK_CATALOG : undefined);
    if (!Array.isArray(fallbackCatalog) || fallbackCatalog.length === 0) {
      throw error;
    }
    return {
      models: fallbackCatalog.map((model) => ({ ...model })),
      source: 'fallback',
      error: error?.message || 'models_list_failed',
    };
  }
}

export {
  SUBSCRIPTION_CATALOG,
  FALLBACK_MODELS,
  DEFAULT_SUBSCRIPTION_MODEL,
  SUBSCRIPTION_MODEL_IDS,
  getSubscriptionModelMetadata,
  isChatModel,
  isLikelyChatModel,
  normalizeApiModelList,
  isSubscriptionUsableModel,
  sortNewestFirst,
};
