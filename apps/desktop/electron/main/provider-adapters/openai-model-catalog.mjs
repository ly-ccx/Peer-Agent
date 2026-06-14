// OpenAI 订阅(ChatGPT OAuth)远程列模型(ADR 28, 方案 B)。
//
// 端点事实:
// - 订阅对话走 https://chatgpt.com/backend-api/codex/responses(无列模型接口)。
// - 标准列模型在 https://api.openai.com/v1/models。本模块用订阅 access token 去打它。
//
// 订阅 token 对 /v1/models 的权限不保证可用(可能 401,或返回的是 API 计费模型)。
// 因此远程失败时回退到内置清单,确保登录后 UI 的模型下拉不为空。
//
// 入参 tokens 形如 { access, accountId },由调用方在刷新后传入。

const MODELS_ENDPOINT = 'https://api.openai.com/v1/models';

// 订阅(ChatGPT OAuth)兜底清单。
//
// 重要事实:订阅链路只走 codex 端点 `chatgpt.com/backend-api/codex/responses`,
// 该端点实际可用的仅 gpt-5 家族。gpt-4o / o3 / o4-mini 等属于按量计费 API 面,
// 用订阅 token 调 codex 端点会失败,因此**不放进订阅清单**,避免给出选了也用不了的项。
// 按"新→旧"排列,第一项即默认"最新"。
const FALLBACK_MODELS = [
  { id: 'gpt-5-codex', label: 'gpt-5-codex' },
  { id: 'gpt-5', label: 'gpt-5' },
];

// 订阅 codex 端点真正可用的模型前缀白名单。远程清单也按此过滤,
// 防止 /v1/models 把 API-only 模型混进订阅下拉。
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
  return /^(gpt-|o\d|chatgpt-)/i.test(id);
}

function toModelInfo(item) {
  return {
    id: item.id,
    label: item.id,
    created: typeof item.created === 'number' ? item.created : undefined,
  };
}

// 按 created 时间戳降序("最新"在前);无时间戳的排后,id 作次序兜底。
function sortNewestFirst(models) {
  return [...models].sort((a, b) => {
    const ca = a.created ?? -1;
    const cb = b.created ?? -1;
    if (ca !== cb) return cb - ca;
    return String(b.id).localeCompare(String(a.id));
  });
}

/**
 * 拉取订阅可用模型列表。
 * @param {{ access?: string, accountId?: string }} tokens
 * @returns {Promise<{ models: Array<{id:string,label:string,created?:number}>, source: 'remote'|'fallback', error?: string }>}
 */
export async function listSubscriptionModels(tokens, { fetchImpl = fetch } = {}) {
  const access = tokens?.access;
  if (!access) {
    return { models: [...FALLBACK_MODELS], source: 'fallback', error: 'missing access token' };
  }

  try {
    const headers = { Authorization: `Bearer ${access}` };
    if (tokens.accountId) headers['chatgpt-account-id'] = tokens.accountId;
    const res = await fetchImpl(MODELS_ENDPOINT, { method: 'GET', headers });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        models: [...FALLBACK_MODELS],
        source: 'fallback',
        error: `HTTP ${res.status}: ${text.slice(0, 200)}`,
      };
    }
    const data = await res.json();
    const raw = Array.isArray(data?.data) ? data.data : [];
    const chat = raw
      .filter((m) => isChatModel(m?.id) && isSubscriptionUsableModel(m?.id))
      .map(toModelInfo);
    if (chat.length === 0) {
      return { models: [...FALLBACK_MODELS], source: 'fallback', error: 'no subscription-usable models in response' };
    }
    return { models: sortNewestFirst(chat), source: 'remote' };
  } catch (err) {
    return {
      models: [...FALLBACK_MODELS],
      source: 'fallback',
      error: err?.message || 'request failed',
    };
  }
}

export { FALLBACK_MODELS, isChatModel, isSubscriptionUsableModel, sortNewestFirst };
