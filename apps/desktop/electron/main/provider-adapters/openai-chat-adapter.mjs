import {
  consumeOpenAIStream,
  sendOpenAIChatStream as sendOpenAIChatStreamShared,
  shouldUsePublicOpenAIChatStream,
} from '@peer-agent/runtime-node';

import { fetchWithConnectionRecovery } from '../provider-transports/recovering-fetch.mjs';

import { trackVisualAdapterResponse } from '../provider-transports/visual-request-context.mjs';

export function sendOpenAIChatStream(options = {}) {
  return trackVisualAdapterResponse('openai', options, () => sendOpenAIChatStreamShared({
    ...options,
    fetchWithRecovery: options.fetchWithRecovery ?? fetchWithConnectionRecovery,
  }));
}

export {
  consumeOpenAIStream,
  shouldUsePublicOpenAIChatStream,
};
