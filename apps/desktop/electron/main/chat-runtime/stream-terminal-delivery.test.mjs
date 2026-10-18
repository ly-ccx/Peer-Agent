import test from 'node:test';
import assert from 'node:assert/strict';
import { createStreamTerminalDelivery, afterTerminalCommit } from './stream-terminal-delivery.mjs';

for (const channel of ['chat:stream:done', 'chat:stream:aborted', 'chat:stream:error']) {
  test(`${channel} and runtime release wait for the same commit, once`, async () => {
    let commit; const persistence = new Promise(resolve => { commit = resolve; }), events = [];
    const record = { streamId: 's', conversationId: 'c', terminalStatus: channel.split(':').at(-1) };
    const deliver = createStreamTerminalDelivery({ record, send: (type) => events.push(type) });
    deliver(persistence, channel, {}); deliver(persistence, channel, {});
    const released = afterTerminalCommit(record, () => events.push('released'));
    assert.deepEqual(events, []); commit(); await released;
    assert.deepEqual(events, [channel, 'released']);
  });
}
test('persistence failure exposes a local failure and never claims done or replays execution', async () => {
  const record = { streamId: 's', terminalStatus: 'done' }, events = [];
  const deliver = createStreamTerminalDelivery({ record, send: (channel, payload) => events.push({ channel, payload }) });
  await deliver(Promise.reject(Object.assign(new Error('disk'), { code: 'ENOSPC' })), 'chat:stream:done', {});
  assert.equal(record.terminalStatus, 'error'); assert.equal(record.recoverable, false);
  assert.equal(events.length, 1); assert.equal(events[0].channel, 'chat:stream:error');
  assert.equal(events[0].payload.error, 'conversation_persistence_failed'); assert.equal(events[0].payload.persistenceError, 'ENOSPC');
});
test('a closed presentation surface cannot strand a committed turn', async () => {
  const record = {}; const deliver = createStreamTerminalDelivery({ record, send: () => { throw Error('window closed'); } });
  await deliver(Promise.resolve(), 'chat:stream:done', {});
  let released = false; await afterTerminalCommit(record, () => { released = true; }); assert.ok(released);
});
