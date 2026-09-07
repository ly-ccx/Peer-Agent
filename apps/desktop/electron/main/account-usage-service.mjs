import { attachAccountLocalUsage } from './account-usage-local.mjs';
import { unavailableAccountUsage } from './account-usage-availability.mjs';
import { accountUsageIdentity } from './account-usage-revision.mjs';

const legacyChannels = {
  oauth_chatgpt: 'openai',
  oauth_google: 'google-ai',
  oauth_grok: 'grok',
  qoder_local_auth: 'qoder',
  local_cli: 'qoder',
};

/** Main-process orchestration. All credential and network dependencies are injected. */
export function createAccountUsageService({ adapters, resolveCredential, fetchLegacyQuota, supportsLegacyQuota, readLocalRows }) {
  return async function fetchAccountUsage({ providerId, llmConfigStore, force = false, fetchImpl }) {
    const providers = llmConfigStore.listProviders();
    const provider = providers.find((item) => item.id === providerId);
    if (!provider) return { success: false, status: 'provider_not_found' };
    const identity = accountUsageIdentity(provider);
    const current = () => identity === accountUsageIdentity(llmConfigStore.listProviders().find((item) => item.id === providerId));
    const changed = () => ({ success: false, status: 'account_changed', providerId });
    let snapshot;
    try {
      if (supportsLegacyQuota(provider.authMethod)
        && (!provider.channelId || legacyChannels[provider.authMethod] === provider.channelId)) {
        snapshot = await fetchLegacyQuota({ providerId, llmConfigStore, force, fetchImpl });
      } else if ((provider.authMethod || 'api_key') === 'api_key' && adapters.supports(provider.channelId)) {
        const credential = await resolveCredential({ provider, llmConfigStore });
        if (!current()) return changed();
        snapshot = await adapters.fetch({ ...provider, authMethod: 'api_key' }, { apiKey: credential.apiKey, force });
      } else {
        snapshot = unavailableAccountUsage(provider.channelId);
      }
    } catch (error) {
      // Do not pass arbitrary credential/network messages across IPC.
      snapshot = { success: false, status: error?.code === 'api_key_not_found' ? 'missing_credential' : 'fetch_failed' };
    }
    if (!current()) return changed();
    const context = { ...snapshot, providerId, channelId: provider.channelId, authMethod: provider.authMethod || 'api_key', accountUsageRevision: provider.accountUsageRevision };
    try {
      const rows = await readLocalRows();
      return current() ? attachAccountLocalUsage(context, provider, providers, rows) : changed();
    } catch { return current() ? { ...context, partial: true } : changed(); }
  };
}
