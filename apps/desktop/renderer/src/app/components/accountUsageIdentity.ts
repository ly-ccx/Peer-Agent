import type { LlmProviderConfigView, LlmSubscriptionQuota } from '@peer-agent/protocol';

export function accountUsageViewIdentity(provider: LlmProviderConfigView | undefined): string {
  return JSON.stringify([provider?.id, provider?.groupId, provider?.channelId, provider?.authMethod,
    provider?.baseUrl, provider?.accountUsageRevision, provider?.oauthStatus]);
}

export function currentAccountUsage(quota: LlmSubscriptionQuota | undefined, provider: LlmProviderConfigView): LlmSubscriptionQuota | undefined {
  if (!quota || quota.status === 'account_changed') return undefined;
  return quota.accountUsageRevision === provider.accountUsageRevision ? quota : undefined;
}
