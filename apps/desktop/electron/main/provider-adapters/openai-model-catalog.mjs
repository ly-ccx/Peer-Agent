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
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    contextWindow: 258_000,
    maxOutputTokens: 128_000,
    inputPrice: 5,
    outputPrice: 30,
    cacheReadPrice: 0.5,
    longContextInputThreshold: 258_000,
    longContextInputPrice: 10,
    longContextCacheReadPrice: 1,
    longContextOutputPrice: 45,
    standardPricing: {
      shortContext: { inputPrice: 5, cacheReadPrice: 0.5, outputPrice: 30 },
      longContext: { inputPrice: 10, cacheReadPrice: 1, outputPrice: 45 },
      longContextInputThreshold: 258_000,
    },
  },
  {
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    contextWindow: 258_000,
    maxOutputTokens: 128_000,
    inputPrice: 2.5,
    outputPrice: 15,
    cacheReadPrice: 0.25,
    longContextInputThreshold: 258_000,
    longContextInputPrice: 5,
    longContextCacheReadPrice: 0.5,
    longContextOutputPrice: 22.5,
    standardPricing: {
      shortContext: { inputPrice: 2.5, cacheReadPrice: 0.25, outputPrice: 15 },
      longContext: { inputPrice: 5, cacheReadPrice: 0.5, outputPrice: 22.5 },
      longContextInputThreshold: 258_000,
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
const DEFAULT_SUBSCRIPTION_MODEL = 'gpt-5.5';

// 合法订阅模型 id 集合,用于迁移时判定旧值是否仍有效。
const SUBSCRIPTION_MODEL_IDS = new Set(SUBSCRIPTION_CATALOG.map((m) => m.id));
const SUBSCRIPTION_MODEL_METADATA = new Map(SUBSCRIPTION_CATALOG.map((m) => [m.id, m]));

// 向后兼容别名:历史调用/测试以 FALLBACK_MODELS 引用同一份清单。
const FALLBACK_MODELS = SUBSCRIPTION_CATALOG;

// 订阅 codex 端点真正可用的模型前缀。仅 gpt-5 家族。
function isSubscriptionUsableModel(id) {
  if (typeof id !== 'string') return false;
  return /^gpt-5/i.test(id);
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

export {
  SUBSCRIPTION_CATALOG,
  FALLBACK_MODELS,
  DEFAULT_SUBSCRIPTION_MODEL,
  SUBSCRIPTION_MODEL_IDS,
  getSubscriptionModelMetadata,
  isChatModel,
  isSubscriptionUsableModel,
  sortNewestFirst,
};
