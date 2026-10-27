/// <reference types="vite/client" />

import type { PeerAgentPreloadApi } from './preload/contracts/peerAgentPreloadApi';

declare global {
  interface Window {
    peerAgent?: PeerAgentPreloadApi;
    peerBrowserWindow?: import('./preload/contracts/browserWindowApi').BrowserWindowApi;
    peerResource?: import('./preload/contracts/resourceWindowApi').ResourceWindowApi;
  }
}

export {};
