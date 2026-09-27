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
      const projectAgent = turnProfile?.role === 'project_agent' || sendMessageArgs.mode === 'project_agent';
      if (!projectAgent) {
        return llmChatService.sendMessage({
          ...sendMessageArgs,
          webContents: sink,
          turnProfile,
        });
      }
      const collected = collectTurn(sink);
      return llmChatService.sendMessage({
        ...sendMessageArgs,
        webContents: collected.sink,
        turnProfile,
      }).then((outcome) => ({
        ...outcome,
        text: typeof outcome?.text === 'string' && outcome.text ? outcome.text : collected.text(),
        toolCalls: Array.isArray(outcome?.toolCalls) ? outcome.toolCalls : collected.toolCalls(),
      }));
    },
  };
}

function collectTurn(sink) {
  const calls = [];
  const byId = new Map();
  let text = '';
  const wrapped = {
    send(channel, payload) {
      sink.send(channel, payload);
      if (channel === 'chat:stream:delta' && typeof payload?.content === 'string') {
        text += payload.content;
      } else if (channel === 'chat:stream:tool-call') {
        const id = typeof payload?.toolCallId === 'string' && payload.toolCallId
          ? payload.toolCallId
          : `call-${calls.length}`;
        const call = {
          name: typeof payload?.tool === 'string' ? payload.tool : '',
          input: payload?.args ?? null,
          result: null,
        };
        calls.push(call);
        byId.set(id, call);
      } else if (channel === 'chat:stream:tool-result') {
        const id = typeof payload?.toolCallId === 'string' ? payload.toolCallId : '';
        const call = (id && byId.get(id)) || calls.find((item) => item.result == null) || null;
        if (call) call.result = parseToolResult(payload?.result);
      }
    },
  };
  if (typeof sink.isDestroyed === 'function') wrapped.isDestroyed = () => sink.isDestroyed();
  if (sink.approver != null) wrapped.approver = sink.approver;
  return {
    sink: wrapped,
    text: () => text,
    toolCalls: () => calls.map((call) => ({ ...call })),
  };
}

function parseToolResult(value) {
  if (typeof value !== 'string') return value ?? null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}
