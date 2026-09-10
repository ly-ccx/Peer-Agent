import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRemoteDeviceHandshake } from './remote-device-handshake.mjs';
import { createRemoteBindingStore } from './remote-binding-store.mjs';
const origin = 'https://peer.example';
const binding = { origin, deviceId: 'mac', ownerId: 'owner', bindingVersion: 1 };
const nonce = 'a'.repeat(43);
const challenge = { type: 'remote.challenge', nonce, expiresAt: 61000,
  message: JSON.stringify(['peer-device-proof-v1', origin, 'connection', nonce, 61000]) };
for (const disk of ['success', 'failure']) {
  for (const local of ['enabled', 'disabled']) {
    test(`handshake-save-${disk}-${local}`, async t => {
      const store = createRemoteBindingStore(':memory:'); t.after(() => store.close());
      const sent = [];
      const h = createRemoteDeviceHandshake({ origin, deviceId: 'mac', now: () => 1000,
        store: { load: store.load, save(value) { if (disk === 'failure') throw new Error('DISK_FAILED'); return store.save(value); } },
        sign: async () => 'signature', send(message) {
          if (message.type === 'remote.binding.ack') assert.deepEqual(store.load(), { ...binding, disabled: false });
          sent.push(message);
        } });
      h.start(); await h.receive(challenge);
      if (local === 'disabled') { store.save(binding); store.setDisabled(true); }
      const reply = { type: 'remote.binding', deviceId: 'mac', ownerId: 'owner', bindingVersion: 1, status: 'awaiting_device_ack' };
      if (disk === 'success' && local === 'enabled') {
        assert.equal((await h.receive(reply)).status, 'saved');
        assert.equal(sent.at(-1).type, 'remote.binding.ack');
        assert.equal((await h.receive({ ...reply, type: 'remote.binding.confirmed', status: 'bound' })).status, 'reconnect');
      } else {
        await assert.rejects(h.receive(reply));
        assert.equal(sent.some(v => v.type === 'remote.binding.ack'), false);
      }
    });
  }
}
test('challenge from another origin or expired challenge is never signed', async t => {
  const store = createRemoteBindingStore(':memory:'); t.after(() => store.close());
  for (const input of [{ ...challenge, expiresAt: 1000 }, { ...challenge, message: challenge.message.replace('peer.example', 'other.example') }]) {
    let signed = false;
    const h = createRemoteDeviceHandshake({ origin, deviceId: 'mac', store, now: () => 1000,
      sign: async () => { signed = true; }, send() {} });
    h.start(); await assert.rejects(h.receive(input), /INVALID_CHALLENGE/);
    assert.equal(signed, false);
  }
});
test('welcome requires exact persisted binding; fresh connection can recover after lost ack response', async t => {
  const store = createRemoteBindingStore(':memory:'); t.after(() => store.close()); store.save(binding);
  for (const ownerId of ['owner', 'other']) {
    const h = createRemoteDeviceHandshake({ origin, store, now: () => 1000, sign: async () => 'signature', send() {} });
    h.start(); await h.receive(challenge);
    const welcome = { type: 'remote.welcome', protocolVersion: 1, connectionEpoch: 2, deviceId: 'mac', ownerId, bindingVersion: 1 };
    if (ownerId === 'owner') assert.equal((await h.receive(welcome)).status, 'online');
    else await assert.rejects(h.receive(welcome), /BINDING_CONFLICT/);
  }
});
