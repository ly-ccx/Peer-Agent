import {
  GROK_CLI_CLIENT_ID,
  GROK_LOGIN_SCOPE,
  GROK_OIDC_ISSUER,
  GROK_REQUIRED_API_SCOPE,
  ensureFreshGrokTokens as ensureFreshSharedGrokTokens,
  refreshGrokTokens as refreshSharedGrokTokens,
  startGrokOAuthLogin as startSharedGrokOAuthLogin,
} from '@peer-agent/runtime-node';
import { fetchGrokWithConnectionRecovery } from '../provider-transports/grok-fetch.mjs';

export {
  GROK_CLI_CLIENT_ID,
  GROK_LOGIN_SCOPE,
  GROK_OIDC_ISSUER,
  GROK_REQUIRED_API_SCOPE,
};

/** Desktop transport adapter for the shared Grok device-login flow. */
export function startGrokOAuthLogin(options = {}) {
  return startSharedGrokOAuthLogin({
    ...options,
    fetchImpl: options.fetchImpl ?? fetchGrokWithConnectionRecovery,
  });
}

/** Desktop transport adapter for shared Grok token refresh. */
export async function refreshGrokTokens(tokens, options = {}) {
  return refreshSharedGrokTokens(tokens, {
    ...options,
    fetchImpl: options.fetchImpl ?? fetchGrokWithConnectionRecovery,
  });
}

/** Desktop transport adapter for shared Grok token freshness checks. */
export async function ensureFreshGrokTokens(tokens, options = {}) {
  return ensureFreshSharedGrokTokens(tokens, {
    ...options,
    fetchImpl: options.fetchImpl ?? fetchGrokWithConnectionRecovery,
  });
}
