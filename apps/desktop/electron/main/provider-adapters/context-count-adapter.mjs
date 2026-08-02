import {
  contextCountCapabilityForProvider,
  countAnthropicCanonicalRequest as countSharedAnthropicCanonicalRequest,
  countGeminiCanonicalRequest as countSharedGeminiCanonicalRequest,
} from '@peer-agent/runtime-node';
import { fetchWithConnectionRecovery } from '../provider-transports/recovering-fetch.mjs';

export { contextCountCapabilityForProvider };

/** Desktop transport adapter for the shared Anthropic count request. */
export async function countAnthropicCanonicalRequest(input = {}) {
  return countSharedAnthropicCanonicalRequest({
    ...input,
    fetchImpl: input.fetchImpl ?? fetchWithConnectionRecovery,
  });
}

/** Desktop transport adapter for the shared Gemini count request. */
export async function countGeminiCanonicalRequest(input = {}) {
  return countSharedGeminiCanonicalRequest({
    ...input,
    fetchImpl: input.fetchImpl ?? fetchWithConnectionRecovery,
  });
}
