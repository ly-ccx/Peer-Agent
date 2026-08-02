import {
  consumeOpenAIStream,
  sendOpenAIChatStream as sendOpenAIChatStreamShared,
  shouldUsePublicOpenAIChatStream,
} from '@peer-agent/runtime-node';

import { fetchWithConnectionRecovery } from '../provider-transports/recovering-fetch.mjs';

export function sendOpenAIChatStream(options = {}) {
  return sendOpenAIChatStreamShared({
    ...options,
    fetchWithRecovery: options.fetchWithRecovery ?? fetchWithConnectionRecovery,
  });
}

export {
  consumeOpenAIStream,
  shouldUsePublicOpenAIChatStream,
};
