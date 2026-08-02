import {
  clearSubscriptionQuotaCache,
  expireFreshSubscriptionQuotaCache,
  fetchChatGptUsage as fetchChatGptUsageShared,
  fetchGeminiQuota as fetchGeminiQuotaShared,
  fetchGrokQuota as fetchGrokQuotaShared,
  fetchProviderSubscriptionQuota as fetchProviderSubscriptionQuotaShared,
  fetchQoderQuota as fetchQoderQuotaShared,
  mapQoderUsageToQuota,
  resolveGeminiCodeAssistProjectId as resolveGeminiCodeAssistProjectIdShared,
  supportsSubscriptionQuota,
} from '@peer-agent/runtime-node';

import {
  getProviderCredentialErrorCode,
  resolveProviderCredential,
} from './provider-credential-resolver.mjs';
import { fetchQoderUsageInfo } from './provider-adapters/qoder-official-model-catalog.mjs';
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

export function resolveGeminiCodeAssistProjectId(options = {}) {
  return resolveGeminiCodeAssistProjectIdShared(withDesktopFetch(options));
}

export function fetchGeminiQuota(options = {}) {
  return fetchGeminiQuotaShared(withDesktopFetch(options));
}

export function fetchGrokQuota(options = {}) {
  return fetchGrokQuotaShared(withDesktopFetch(options));
}

export function fetchQoderQuota(options = {}) {
  return fetchQoderQuotaShared({
    ...options,
    usageLoader: options.usageLoader ?? fetchQoderUsageInfo,
  });
}

export function fetchProviderSubscriptionQuota(options = {}) {
  return fetchProviderSubscriptionQuotaShared({
    ...options,
    fetchImpl: options.fetchImpl ?? fetchWithConnectionRecovery,
    resolveCredential: options.resolveCredential ?? resolveProviderCredential,
    getCredentialErrorCode: options.getCredentialErrorCode ?? getProviderCredentialErrorCode,
    qoderUsageLoader: options.qoderUsageLoader ?? fetchQoderUsageInfo,
  });
}

export {
  clearSubscriptionQuotaCache,
  expireFreshSubscriptionQuotaCache,
  mapQoderUsageToQuota,
  supportsSubscriptionQuota,
};
