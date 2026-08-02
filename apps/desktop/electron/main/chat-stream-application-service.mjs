function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

export function createChatStreamApplicationService(options = {}) {
  const ports = {
    abortStream: assertFunction(options.abortStream, 'abortStream'),
    reattachStream: assertFunction(options.reattachStream, 'reattachStream'),
    listActiveConversationIds: assertFunction(
      options.listActiveConversationIds,
      'listActiveConversationIds',
    ),
    listActiveStreams: assertFunction(options.listActiveStreams, 'listActiveStreams'),
  };

  return Object.freeze({
    abort({ streamId } = {}) {
      return ports.abortStream(streamId);
    },
    reattach(input = {}) {
      return ports.reattachStream(input);
    },
    listActive() {
      return {
        conversationIds: ports.listActiveConversationIds(),
        streams: ports.listActiveStreams(),
      };
    },
  });
}
