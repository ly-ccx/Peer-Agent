import {
  QODER_CONNECTION_RETRY_DELAYS_MS,
  QODER_QUEUE_DEFAULT_WAIT_MS,
  QODER_QUEUE_LONG_WAIT_HINT_MS,
  QODER_QUEUE_MAX_RETRIES,
  QODER_QUEUE_MAX_WAIT_MS,
  QODER_TRANSIENT_RETRY_DELAYS_MS,
  buildQoderPrivateHeaders,
  buildQoderPrivateRequestBody,
  buildQoderRemoteChatAsk,
  classifyQoderStreamFailure,
  computeQoderQueueWaitMs,
  formatQoderDuplicateError,
  formatQoderQueueError,
  formatQoderQueueStatusMessage,
  mergeConsecutiveAssistants,
  normalizeQoderModel,
  normalizeQoderPreparedEndpoint,
  qoderModelServerBaseUrl,
  qoderTurnTaskId,
  resolveQoderReasoningEffortParam,
  sanitizeQoderToolPairing,
  sendQoderPrivateStream as sendQoderPrivateStreamShared,
} from '@peer-agent/runtime-node';

import { fetchWithConnectionRecovery } from '../provider-transports/recovering-fetch.mjs';
import { consumeOpenAIStream } from './openai-chat-adapter.mjs';

export function sendQoderPrivateStream(options = {}) {
  return sendQoderPrivateStreamShared({
    ...options,
    fetchWithRecovery: options.fetchWithRecovery ?? fetchWithConnectionRecovery,
    consumeStream: options.consumeStream ?? consumeOpenAIStream,
  });
}

export {
  QODER_CONNECTION_RETRY_DELAYS_MS,
  QODER_QUEUE_DEFAULT_WAIT_MS,
  QODER_QUEUE_LONG_WAIT_HINT_MS,
  QODER_QUEUE_MAX_RETRIES,
  QODER_QUEUE_MAX_WAIT_MS,
  QODER_TRANSIENT_RETRY_DELAYS_MS,
  buildQoderPrivateHeaders,
  buildQoderPrivateRequestBody,
  buildQoderRemoteChatAsk,
  classifyQoderStreamFailure,
  computeQoderQueueWaitMs,
  formatQoderDuplicateError,
  formatQoderQueueError,
  formatQoderQueueStatusMessage,
  mergeConsecutiveAssistants,
  normalizeQoderModel,
  normalizeQoderPreparedEndpoint,
  qoderModelServerBaseUrl,
  qoderTurnTaskId,
  resolveQoderReasoningEffortParam,
  sanitizeQoderToolPairing,
};
