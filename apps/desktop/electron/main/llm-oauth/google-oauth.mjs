import {
  ensureFreshGoogleTokens as ensureFreshSharedGoogleTokens,
  refreshGoogleAccessToken as refreshSharedGoogleAccessToken,
  startGoogleBrowserLogin as startSharedGoogleBrowserLogin,
} from '@peer-agent/runtime-node';
import { fetchWithConnectionRecovery } from '../provider-transports/recovering-fetch.mjs';

async function openInBrowser(url) {
  const { shell } = await import('electron');
  await shell.openExternal(url);
}

/** Desktop transport adapter for the shared Google OAuth refresh flow. */
export async function refreshGoogleAccessToken(tokens, options = {}) {
  return refreshSharedGoogleAccessToken(tokens, {
    ...options,
    fetchImpl: options.fetchImpl ?? fetchWithConnectionRecovery,
  });
}

/** Desktop transport adapter for the shared Google token freshness check. */
export async function ensureFreshGoogleTokens(tokens, options = {}) {
  return ensureFreshSharedGoogleTokens(tokens, {
    ...options,
    fetchImpl: options.fetchImpl ?? fetchWithConnectionRecovery,
  });
}

/** Desktop browser/transport adapter for the shared PKCE login flow. */
export function startGoogleBrowserLogin(options = {}) {
  return startSharedGoogleBrowserLogin({
    ...options,
    fetchImpl: options.fetchImpl ?? fetchWithConnectionRecovery,
    openExternal: options.openExternal ?? openInBrowser,
  });
}
