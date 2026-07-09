import type { LlmProviderConfigView } from '@peer-agent/protocol';

const CHATGPT_SUBSCRIPTION_DISPLAY_NAME_ZH = 'ChatGPT 订阅';
const CHATGPT_SUBSCRIPTION_DISPLAY_NAME_EN = 'ChatGPT Subscription';

const DEFAULT_CHATGPT_SUBSCRIPTION_NAMES = new Set([
  CHATGPT_SUBSCRIPTION_DISPLAY_NAME_ZH,
  CHATGPT_SUBSCRIPTION_DISPLAY_NAME_EN,
]);

export function getProviderDisplayName(provider: Pick<LlmProviderConfigView, 'authMethod' | 'name' | 'model'>, isZh: boolean): string {
  const name = provider.name?.trim();
  if (provider.authMethod === 'oauth_chatgpt' && (!name || DEFAULT_CHATGPT_SUBSCRIPTION_NAMES.has(name))) {
    return isZh ? CHATGPT_SUBSCRIPTION_DISPLAY_NAME_ZH : CHATGPT_SUBSCRIPTION_DISPLAY_NAME_EN;
  }
  return name || provider.model;
}

export function getProviderModelDisplayLabel(
  provider: Pick<LlmProviderConfigView, 'authMethod' | 'name' | 'model' | 'modelLabel'>,
  isZh: boolean,
): string {
  if (provider.modelLabel) return provider.modelLabel;
  const providerName = getProviderDisplayName(provider, isZh);
  return providerName ? `${providerName} · ${provider.model}` : provider.model;
}
