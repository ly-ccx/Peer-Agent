import { createAccountUsageAdapters } from '@peer-agent/runtime-node';
import { fetchProviderSubscriptionQuota, supportsSubscriptionQuota } from './subscription-quota.mjs';
import { resolveProviderCredential } from './provider-credential-resolver.mjs';
import { createUsageRequestLog } from './usage-request-log.mjs';
import { createAccountUsageService } from './account-usage-service.mjs';

const adapters = createAccountUsageAdapters();
const log = createUsageRequestLog();

export const fetchProviderAccountUsage = createAccountUsageService({
  adapters,
  resolveCredential: resolveProviderCredential,
  fetchLegacyQuota: fetchProviderSubscriptionQuota,
  supportsLegacyQuota: supportsSubscriptionQuota,
  readLocalRows: () => log.readAll(),
});
