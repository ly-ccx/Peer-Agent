import {
  clearSubscriptionQuotaCache,
  expireFreshSubscriptionQuotaCache,
  fetchChatGptUsage as fetchChatGptUsageShared,
  fetchGrokQuota as fetchGrokQuotaShared,
  fetchProviderSubscriptionQuota as fetchProviderSubscriptionQuotaShared,
  supportsSubscriptionQuota,
} from '@peer-agent/runtime-node';

import {
  getProviderCredentialErrorCode,
  resolveProviderCredential,
} from './provider-credential-resolver.mjs';
import { fetchWithConnectionRecovery } from './provider-transports/recovering-fetch.mjs';

function withDesktopFetch(options = {}) {
  return {
    ...options,
    fetchImpl: options.fetchImpl ?? fetchWithConnectionRecovery,
  };
}

export function fetchChatGptUsage(options = {}) {
  return fetchChatGptUsageShared(withDesktopFetch(options));
}

export function fetchGrokQuota(options = {}) {
  return fetchGrokQuotaShared(withDesktopFetch(options));
}

export function fetchProviderSubscriptionQuota(options = {}) {
  return fetchProviderSubscriptionQuotaShared({
    ...options,
    fetchImpl: options.fetchImpl ?? fetchWithConnectionRecovery,
    resolveCredential: options.resolveCredential ?? resolveProviderCredential,
    getCredentialErrorCode: options.getCredentialErrorCode ?? getProviderCredentialErrorCode,
  });
}

export {
  clearSubscriptionQuotaCache,
  expireFreshSubscriptionQuotaCache,
  supportsSubscriptionQuota,
};
