function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function owner(ownerName, register) {
  return Object.freeze({ owner: ownerName, register });
}

export function createConversationSessionIpcRegistrations({ conversationSession } = {}) {
  const setActiveConversation = assertFunction(
    conversationSession?.setActiveConversation,
    'conversationSession.setActiveConversation',
  );

  return [
    owner('conversation-ipc', (ipc) => {
      ipc.handle('conversation:set-active', (_event, payload = {}) =>
        setActiveConversation(payload));
    }),
  ];
}
