import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentTurnExecutor } from './agent-turn-executor.mjs';
import { createBroadcastSink } from './turn-sinks.mjs';

test('runTurn forwards the sink and turn profile and returns the service outcome', async () => {
  const seen = [];
  const executor = createAgentTurnExecutor({
    llmChatService: {
      async sendMessage(input) {
        input.webContents.send('chat:stream:delta', { content: 'ok' });
        seen.push(input.turnProfile);
        return { terminalStatus: 'done', toolCallCount: 0 };
      },
    },
  });
  const events = [];
  const outcome = await executor.runTurn({
    turnProfile: { role: 'goal_runner' },
    sink: { send: (channel, payload) => events.push({ channel, payload }) },
    streamId: 's1',
    messages: [],
  });
  assert.deepEqual(outcome, { terminalStatus: 'done', toolCallCount: 0 });
  assert.deepEqual(seen, [{ role: 'goal_runner' }]);
  assert.deepEqual(events, [{ channel: 'chat:stream:delta', payload: { content: 'ok' } }]);
});

test('a goal turn still finishes when the broadcast sink has no windows', async () => {
  const executor = createAgentTurnExecutor({
    llmChatService: {
      async sendMessage(input) {
        input.webContents.send('chat:stream:delta', { content: 'background' });
        input.webContents.send('chat:stream:done', {});
        return { terminalStatus: 'done' };
      },
    },
  });
  const outcome = await executor.runTurn({
    turnProfile: { role: 'goal_runner' },
    sink: createBroadcastSink({ getWindows: () => [] }),
    streamId: 's2',
  });
  assert.equal(outcome.terminalStatus, 'done');
});

test('runTurn rejects a missing chat service or sink', () => {
  assert.throws(() => createAgentTurnExecutor({}), /sendMessage/);
  const executor = createAgentTurnExecutor({ llmChatService: { async sendMessage() {} } });
  assert.throws(() => executor.runTurn({ sink: {} }), /sink/);
});
