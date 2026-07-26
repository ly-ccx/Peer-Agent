import type { ModelStreamEvent } from '@peer-agent/runtime-node';

/**
 * Desktop stream adapters write live deltas through Electron webContents.
 * TUI has no renderer IPC, so bridge those channels into ModelProvider onEvent.
 */
export function createTuiWebContentsBridge(
  onEvent?: (event: ModelStreamEvent) => void,
): { send: (channel: string, payload?: Record<string, unknown>) => void; isDestroyed: () => boolean } {
  return {
    isDestroyed: () => false,
    send(channel, payload = {}) {
      if (!onEvent) return;
      const content = typeof payload.content === 'string' ? payload.content : '';
      if (!content) return;
      if (channel === 'chat:stream:delta') {
        onEvent({ type: 'text.delta', content });
        return;
      }
      if (channel === 'chat:stream:thinking') {
        onEvent({ type: 'reasoning.delta', content });
      }
    },
  };
}
