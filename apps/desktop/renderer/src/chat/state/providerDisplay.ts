import { modelMenuChannelName, type LlmProviderConfigView } from '@peer-agent/protocol';

export function getProviderDisplayName(provider: Pick<LlmProviderConfigView, 'authMethod' | 'name' | 'model'>, isZh: boolean): string {
  return modelMenuChannelName(provider.name, provider.model, provider.authMethod, isZh);
}

export function getProviderModelDisplayLabel(
  provider: Pick<LlmProviderConfigView, 'authMethod' | 'name' | 'model' | 'modelLabel'>,
  isZh: boolean,
): string {
  if (provider.modelLabel) return provider.modelLabel;
  const providerName = getProviderDisplayName(provider, isZh);
  return providerName ? `${providerName} · ${provider.model}` : provider.model;
}
