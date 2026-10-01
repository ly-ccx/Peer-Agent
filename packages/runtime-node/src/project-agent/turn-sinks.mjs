export function createCollectingSink() {
  const events = [];
  let text = '';
  let terminal = null;
  return {
    approver: 'none',
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

export function createCallbackSink(onEvent = null) {
  return {
    isDestroyed: () => false,
    send(channel, payload) {
      onEvent?.({ channel, payload });
    },
  };
}
