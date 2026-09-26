/**
 * Runs one agent turn through an existing chat service.
 * The sink receives stream events. The service still owns tools, permissions, and persistence.
 * @param {{ llmChatService: { sendMessage: (input: object) => Promise<object> } }} options
 */
export function createAgentTurnExecutor({ llmChatService } = {}) {
  if (typeof llmChatService?.sendMessage !== 'function') {
    throw new Error('AgentTurnExecutor requires llmChatService.sendMessage');
  }
  return {
    /**
     * @param {object} input
     * @param {object} [input.turnProfile]
     * @param {{ send: (channel: string, payload: unknown) => void }} input.sink
     */
    runTurn({ turnProfile = null, sink, ...sendMessageArgs } = {}) {
      if (!sink || typeof sink.send !== 'function') {
        throw new Error('AgentTurnExecutor requires a sink with send()');
      }
      return llmChatService.sendMessage({
        ...sendMessageArgs,
        webContents: sink,
        turnProfile,
      });
    },
  };
}
