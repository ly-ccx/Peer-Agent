import { sendAnthropicMessagesStream as sendSharedAnthropicMessagesStream } from '@peer-agent/runtime-node';
import { fetchWithConnectionRecovery } from '../provider-transports/recovering-fetch.mjs';

/**
 * Desktop host adapter for the shared Anthropic Messages stream algorithm.
 * Electron owns the concrete network transport; the shared runtime owns request
 * encoding, SSE parsing, tracing, and stream result behavior.
 */
export async function sendAnthropicMessagesStream(input = {}) {
  return sendSharedAnthropicMessagesStream({
    ...input,
    fetchImpl: input.fetchImpl ?? fetchWithConnectionRecovery,
  });
}
