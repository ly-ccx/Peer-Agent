import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startRemoteDeviceConnector } from './remote-device-connector.mjs';
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const calls = []; const scheduled = []; let disabled = false;
  const supervisor = startRemoteDeviceConnector({ store: { load: () => ({ disabled }) } }, {
    random: () => 1,
    connect(options) {
      let finish;
      const call = { options, stops: 0, closed: new Promise(resolve => { finish = resolve; }),
        stop() { this.stops++; }, finish: (reason, detail) => finish({ reason, detail }) };
      calls.push(call); return call;
    },
    schedule(fn, delay) { const entry = { fn, delay, cancelled: false }; scheduled.push(entry); return () => { entry.cancelled = true; }; },
  });
  return { supervisor, calls, scheduled, disable() { disabled = true; } };
}
for (const reason of ['reconnect', 'disconnected', 'protocol_failure', 'disabled']) {
  for (const stopping of ['none', 'before-close', 'during-backoff']) {
    test(`supervisor-${reason}-${stopping}`, async () => {
      const f = fixture(); const first = f.calls[0];
      first.options.onState({ status: 'online' });
      if (stopping === 'before-close') f.supervisor.stop();
      first.finish(reason); await flush();
      const retry = ['reconnect', 'disconnected'].includes(reason) && stopping !== 'before-close';
      assert.equal(f.scheduled.length, retry ? 1 : 0);
      if (retry) {
        assert.equal(f.scheduled[0].delay, reason === 'reconnect' ? 0 : 1000);
        if (stopping === 'during-backoff') f.supervisor.stop();
        f.scheduled[0].fn(); // Even a late cancelled callback cannot create a connection.
        assert.equal(f.calls.length, stopping === 'during-backoff' ? 1 : 2);
      }
      f.supervisor.stop(); await f.supervisor.closed;
    });
  }
}
test('local disable while awaiting retry prevents socket creation', async () => {
  const f = fixture(); f.calls[0].options.onState({ status: 'online' });
  f.calls[0].finish('disconnected'); await flush();
  f.disable(); f.scheduled[0].fn();
  assert.equal(f.calls.length, 1);
  assert.equal((await f.supervisor.closed).reason, 'disabled');
});
test('unclassified pre-auth transport failure fails closed instead of retrying TLS errors', async () => {
  const f = fixture(); f.calls[0].finish('transport_failure');
  assert.equal((await f.supervisor.closed).reason, 'transport_failure');
  assert.equal(f.scheduled.length, 0);
});
test('a failing connection reports the raw transport code, not just its category', async () => {
  // Regression: every non-transient failure used to arrive as a bare
  // 'transport_failure'. A bad certificate, a typo'd host, and a refused port all
  // looked identical, so the settings panel could only say "connecting…" forever.
  const f = fixture();
  f.calls[0].finish('transport_failure', { code: 'SELF_SIGNED_CERT_IN_CHAIN' });
  const closed = await f.supervisor.closed;
  assert.equal(closed.reason, 'transport_failure');
  assert.equal(closed.detail.code, 'SELF_SIGNED_CERT_IN_CHAIN');
  assert.equal(f.scheduled.length, 0, 'a security failure must still fail closed');
});
test('a thrown local defect reports why instead of a bare local_failure', async () => {
  const detail = { code: 'ERR_INVALID_ARG_TYPE', message: 'options.publicKey must be a string' };
  const supervisor = startRemoteDeviceConnector(
    { store: { load: () => ({ disabled: false }) } },
    {
      random: () => 1,
      connect() { throw Object.assign(new Error(detail.message), { code: detail.code }); },
      schedule() { return () => {}; },
    },
  );
  const closed = await supervisor.closed;
  assert.equal(closed.reason, 'local_failure');
  assert.equal(closed.detail.code, detail.code);
  assert.equal(closed.detail.message, detail.message);
});
test('a rejected closed promise keeps its reason on connection_failure', async () => {
  const supervisor = startRemoteDeviceConnector(
    { store: { load: () => ({ disabled: false }) } },
    {
      random: () => 1,
      connect() {
        return {
          stop() {},
          closed: Promise.reject(Object.assign(new Error('socket teardown failed'), { code: 'ERR_SOCKET' })),
        };
      },
      schedule() { return () => {}; },
    },
  );
  const closed = await supervisor.closed;
  assert.equal(closed.reason, 'connection_failure');
  assert.equal(closed.detail.code, 'ERR_SOCKET');
});
