export type LlmBrandId =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'xai'
  | 'qoder'
  | 'deepseek'
  | 'zhipu'
  | 'kimi'
  | 'moonshot'
  | 'minimax'
  | 'volcengine'
  | 'xiaomi'
  | 'bailian'
  | 'opencode'
  | 'qwen'
  | 'meta'
  | 'mistral'
  | 'unknown'

export interface LlmBrandHints {
  readonly brand?: string;
  readonly channelId?: string;
  readonly providerName?: string;
  readonly serviceTemplateId?: string;
  readonly modelId?: string;
}

const BRAND_LABELS: Readonly<Record<LlmBrandId, string>> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google Gemini',
  xai: 'xAI',
  qoder: 'Qoder',
  deepseek: 'DeepSeek',
  zhipu: '智谱 GLM',
  kimi: 'Kimi',
  moonshot: 'Moonshot',
  minimax: 'MiniMax',
  volcengine: 'Volcengine',
  xiaomi: 'Xiaomi MiMo',
  bailian: 'Aliyun Bailian',
  opencode: 'OpenCode',
  qwen: 'Qwen',
  meta: 'Meta',
  mistral: 'Mistral AI',
  unknown: 'Custom provider',
};

function matchBrand(value: string): LlmBrandId | null {
  // Channel / template ids like opencode-go / opencode-go-openai must win before generic anthropic/openai.
  if (/opencode|opencode-go|\bzen\b/.test(value)) return 'opencode';
  if (/\b(anthropic|claude)\b/.test(value)) return 'anthropic';
  if (/\b(google|gemini|gemma|vertex)\b/.test(value)) return 'google';
  if (/\b(xai|grok)\b/.test(value)) return 'xai';
  if (/\b(qoder)\b/.test(value)) return 'qoder';
  if (/deepseek/.test(value)) return 'deepseek';
  // 智谱 / GLM Coding Plan / bigmodel / z.ai
  if (/zhipu|bigmodel|智谱|glm-coding-plan|\bglm\b|\bz\.ai\b/.test(value)) return 'zhipu';
  // Kimi Coding Plan models / channel ids first (model ids start with kimi-)
  if (/kimi-coding-plan|\bkimi\b/.test(value)) return 'kimi';
  if (/moonshot|月之暗面/.test(value)) return 'moonshot';
  if (/minimax|minimaxi/.test(value)) return 'minimax';
  if (/volcengine|volces|\bark\b|火山|方舟|doubao|豆包/.test(value)) return 'volcengine';
  if (/xiaomi|xiaomimimo|\bmimo\b|小米/.test(value)) return 'xiaomi';
  if (/bailian|aliyun-bailian|dashscope|百炼/.test(value)) return 'bailian';
  if (/qwen|tongyi/.test(value)) return 'qwen';
  if (/\bmeta\b|llama/.test(value)) return 'meta';
  if (/mistral|mixtral|codestral/.test(value)) return 'mistral';
  if (/\b(openai|chatgpt|codex|gpt(?:-|\b)|o[134](?:-|\b))/.test(value)) return 'openai';
  return null;
}

/** Resolve one visual brand for provider and model rows without relying on remote assets. */
export function resolveLlmBrand(hints: LlmBrandHints): LlmBrandId {
  const modelBrand = matchBrand((hints.modelId ?? '').toLowerCase());
  if (modelBrand) return modelBrand;

  const provider = [hints.brand, hints.channelId, hints.providerName, hints.serviceTemplateId]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (/\bcompatible\b|\b兼容\b/.test(provider)) return 'unknown';
  return matchBrand(provider) ?? 'unknown';
}

export function llmBrandLabel(brand: LlmBrandId): string {
  return BRAND_LABELS[brand];
}
