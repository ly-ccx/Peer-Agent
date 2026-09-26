import assert from 'node:assert/strict';
import test from 'node:test';
import { createScriptedTurnExecutor } from './scripted-turn-executor.mjs';

test('scripted executor plays text, a tool call, and each terminal status', async () => {
  for (const channel of ['done', 'error', 'aborted']) {
    const events = [];
    const sink = { send: (name, payload) => events.push({ name, payload }) };
    const executor = createScriptedTurnExecutor([
      { type: 'delta', content: 'hello ' },
      { type: 'delta', content: 'world' },
      {
        type: 'tool',
        name: 'read_file',
        input: { path: 'a.txt' },
        async executeTool() { return { ok: true }; },
      },
      { type: 'terminal', channel, payload: { reason: channel } },
    ]);
    const outcome = await executor.runTurn({ sink, turnProfile: { role: 'goal_runner' } });
    assert.equal(outcome.text, 'hello world');
    assert.equal(outcome.toolCallCount, 1);
    assert.equal(outcome.terminalStatus, channel === 'done' ? 'done' : channel);
    assert.equal(outcome.turnProfile.role, 'goal_runner');
    assert.equal(events.some((event) => event.name === 'chat:stream:tool-result'), true);
    assert.equal(events.at(-1).name, `chat:stream:${channel}`);
  }
});
