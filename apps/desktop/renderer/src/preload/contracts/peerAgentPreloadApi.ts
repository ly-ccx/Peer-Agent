import type { BootstrapPreloadApi } from './bootstrapPreloadApi';

import type { ChatPreloadApi } from './chatPreloadApi';

export interface PeerAgentPreloadApi extends BootstrapPreloadApi, ChatPreloadApi {
  readonly inputPredictionRequest: import('@peer-agent/protocol').InputPredictionPort['request'];
  readonly inputPredictionCancel: import('@peer-agent/protocol').InputPredictionPort['cancel'];
  readonly inputPredictionValidate: import('@peer-agent/protocol').InputPredictionPort['validate'];
  readonly inputPredictionStatus: () => Promise<import('@peer-agent/protocol').InputPredictionStatus>;
}
