import type { PeerAgentPreloadApi } from './preload/contracts/peerAgentPreloadApi';

declare global {
  interface Window {
    peerAgent?: PeerAgentPreloadApi;
  }
}

export {};
