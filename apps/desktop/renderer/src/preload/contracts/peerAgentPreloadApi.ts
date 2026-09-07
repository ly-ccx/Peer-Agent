import type { BootstrapPreloadApi } from './bootstrapPreloadApi';

import type { ChatPreloadApi } from './chatPreloadApi';

export interface PeerAgentPreloadApi extends BootstrapPreloadApi, ChatPreloadApi {}
