/**
 * A turn event receiver. Callers may only use `send`, and `isDestroyed` when present.
 * Electron-only members such as `id`, `on`, or `session` are not part of the contract.
 *
 * @typedef {Object} TurnSink
 * @property {(channel: string, payload: unknown) => void} send
 * @property {() => boolean} [isDestroyed] Absent means the sink is still usable.
 */

/**
 * In-memory sink for Explorer and Verifier. It does not forward to a window.
 * @returns {TurnSink & { getText: () => string, getEvents: () => Array<{channel: string, payload: unknown}>, getTerminal: () => {channel: string, payload: unknown} | null }}
 */
export function createCollectingSink() {
  const events = [];
  let text = '';
  let terminal = null;
  return {
    send(channel, payload) {
      events.push({ channel, payload });
      if (channel === 'chat:stream:delta' && typeof payload?.content === 'string') {
        text += payload.content;
      }
      if (channel === 'chat:stream:done' || channel === 'chat:stream:error' || channel === 'chat:stream:aborted') {
        terminal = { channel, payload };
      }
    },
    getText() {
      return text;
    },
    getEvents() {
      return events.slice();
    },
    getTerminal() {
      return terminal;
    },
  };
}

/**
 * Forwards each event to a callback. Never reports itself destroyed.
 * @param {((event: { channel: string, payload: unknown }) => void) | null} [onEvent]
 * @returns {TurnSink}
 */
/**
 * Sends each event to every window that is still alive. No windows means the
 * event is dropped; the turn record remains the source of truth.
 * @param {{ getWindows?: () => unknown[] }} [options]
 * @returns {TurnSink}
 */
export function createBroadcastSink({ getWindows } = {}) {
  return {
    isDestroyed: () => false,
    send(channel, payload) {
      const windows = typeof getWindows === 'function' ? getWindows() : [];
      if (!Array.isArray(windows)) return;
      for (const window of windows) {
        if (!window || window.isDestroyed?.()) continue;
        const target = window.webContents && typeof window.webContents.send === 'function'
          ? window.webContents
          : window;
        if (target.isDestroyed?.()) continue;
        if (typeof target.send !== 'function') continue;
        target.send(channel, payload);
      }
    },
  };
}

export function createCallbackSink(onEvent = null) {
  return {
    isDestroyed: () => false,
    send(channel, payload) {
      onEvent?.({ channel, payload });
    },
  };
}
