import { sendGeminiStream as sendSharedGeminiStream } from '@peer-agent/runtime-node';
import { fetchWithConnectionRecovery } from '../provider-transports/recovering-fetch.mjs';

/**
 * Desktop host adapter for the shared Gemini stream algorithm.
 * Electron owns the concrete network transport; the shared runtime owns request
 * encoding, SSE parsing, tracing, and stream result behavior.
 */
export async function sendGeminiStream(input = {}) {
  return sendSharedGeminiStream({
    ...input,
    fetchImpl: input.fetchImpl ?? fetchWithConnectionRecovery,
  });
}
