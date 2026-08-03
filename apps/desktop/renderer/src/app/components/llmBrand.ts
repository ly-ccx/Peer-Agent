export type LlmBrandId =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'xai'
  | 'qoder'
  | 'deepseek'
  | 'qwen'
  | 'meta'
  | 'mistral'
  | 'unknown';

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
  qwen: 'Qwen',
  meta: 'Meta',
  mistral: 'Mistral AI',
  unknown: 'Custom provider',
};

function matchBrand(value: string): LlmBrandId | null {
  if (/\b(anthropic|claude)\b/.test(value)) return 'anthropic';
  if (/\b(google|gemini|gemma|vertex)\b/.test(value)) return 'google';
  if (/\b(xai|grok)\b/.test(value)) return 'xai';
  if (/\b(qoder)\b/.test(value)) return 'qoder';
  if (/deepseek/.test(value)) return 'deepseek';
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
