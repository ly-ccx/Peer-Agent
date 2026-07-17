import { fetchWithConnectionRecovery } from './recovering-fetch.mjs';

// Keep every Grok network path on the same proxy-aware transport policy.
// Callers may still inject fetchImpl directly for focused unit tests.
export function fetchGrokWithConnectionRecovery(url, init = {}, options = {}) {
  return fetchWithConnectionRecovery(url, init, {
    provider: 'grok',
    ...options,
  });
}
