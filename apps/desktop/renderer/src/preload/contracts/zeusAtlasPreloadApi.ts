import type { BootstrapPreloadApi } from './bootstrapPreloadApi';
import type { ChatPreloadApi } from './chatPreloadApi';

export interface ZeusAtlasPreloadApi extends BootstrapPreloadApi {
  readonly chat: ChatPreloadApi;
}
