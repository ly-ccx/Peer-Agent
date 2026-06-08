import type { ZeusAtlasPreloadApi } from './preload/contracts/zeusAtlasPreloadApi';

declare global {
  interface Window {
    zeusAtlas?: ZeusAtlasPreloadApi;
  }
}

export {};
