const TERMINAL_CHANNELS = new Set(['chat:stream:done', 'chat:stream:error', 'chat:stream:aborted']);

function terminalStatusFor(channel) {
  if (channel === 'chat:stream:error') return 'error';
  if (channel === 'chat:stream:aborted') return 'aborted';
  return 'done';
}

/**
 * A turn executor that plays a script instead of calling a model.
 * Steps: `{ type: 'delta', content }`, `{ type: 'tool', name, input, executeTool }`,
 * `{ type: 'terminal', channel: 'done' | 'error' | 'aborted', payload }`.
 * @param {readonly object[]} [script]
 */
export function createScriptedTurnExecutor(script = []) {
  const steps = Array.isArray(script) ? script : [];
  return {
    async runTurn({ sink, turnProfile = null } = {}) {
      const target = sink && typeof sink.send === 'function' ? sink : { send() {} };
      let text = '';
      let toolCallCount = 0;
      let terminalChannel = 'chat:stream:done';
      for (const step of steps) {
        if (!step || typeof step !== 'object') continue;
        if (step.type === 'delta') {
          const content = typeof step.content === 'string' ? step.content : '';
          target.send('chat:stream:delta', { content });
          text += content;
        } else if (step.type === 'tool') {
          toolCallCount += 1;
          target.send('chat:stream:tool-call', { name: step.name, input: step.input });
          if (typeof step.executeTool === 'function') {
            const result = await step.executeTool(step);
            target.send('chat:stream:tool-result', { name: step.name, result });
          }
        } else if (step.type === 'terminal') {
          const channel = TERMINAL_CHANNELS.has(step.channel)
            ? step.channel
            : `chat:stream:${step.channel || 'done'}`;
          const resolved = TERMINAL_CHANNELS.has(channel) ? channel : 'chat:stream:done';
          terminalChannel = resolved;
          target.send(resolved, step.payload ?? {});
        }
      }
      return {
        terminalStatus: terminalStatusFor(terminalChannel),
        text,
        toolCallCount,
        turnProfile,
      };
    },
  };
}
