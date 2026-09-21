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

test('配对事件保留服务器下发的全部字段，供设置页展示', async t => {
  // 设置页要靠这四个字段才能完成认领：挑战 ID 和一次性 Key 是用户要填到网页上的，
  // deviceId 标识这台机器，expiresAt 用来提示剩余时间。少任何一个，配对都做不下去，
  // 所以这里钉住形状，避免上游改动时静默丢字段。
  const store = createRemoteBindingStore(':memory:'); t.after(() => store.close());
  // 首次配对走 enroll 分支（服务器还不认识这台机器），pairing 正是从这里下发的。
  const h = createRemoteDeviceHandshake({
    origin, store, now: () => 1000, sign: async () => 'signature', send() {},
    publicKey: '-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----', name: 'mac',
  });
  h.start();
  await h.receive(challenge);

  const pairing = {
    type: 'remote.pairing',
    challengeId: '11111111-2222-4333-8444-555555555555',
    pairingKey: 'AbCdEfGhIjKlMnOpQrStUvWxYz012345',
    deviceId: '66666666-7777-4888-8999-aaaaaaaaaaaa',
    expiresAt: 99999,
  };
  const result = await h.receive(pairing);

  assert.equal(result.status, 'pairing');
  assert.deepEqual(result.pairing, pairing, '字段必须原样带出，一个都不能少');
});

test('形状不对的配对消息被拒绝，不会让设置页展示半个挑战', async t => {
  const store = createRemoteBindingStore(':memory:'); t.after(() => store.close());
  const bad = [
    // 缺 expiresAt：UI 就没法提示剩余时间，也没法判断何时失效
    { type: 'remote.pairing', challengeId: '11111111-2222-4333-8444-555555555555', pairingKey: 'AbCdEfGhIjKlMnOpQrStUvWxYz012345', deviceId: '66666666-7777-4888-8999-aaaaaaaaaaaa' },
    // 已过期（now() = 1000）
    { type: 'remote.pairing', challengeId: '11111111-2222-4333-8444-555555555555', pairingKey: 'AbCdEfGhIjKlMnOpQrStUvWxYz012345', deviceId: '66666666-7777-4888-8999-aaaaaaaaaaaa', expiresAt: 999 },
    // 多带了未约定的键
    { type: 'remote.pairing', challengeId: '11111111-2222-4333-8444-555555555555', pairingKey: 'AbCdEfGhIjKlMnOpQrStUvWxYz012345', deviceId: '66666666-7777-4888-8999-aaaaaaaaaaaa', expiresAt: 99999, extra: 1 },
  ];
  for (const message of bad) {
    const h = createRemoteDeviceHandshake({
      origin, store, now: () => 1000, sign: async () => 'signature', send() {},
      publicKey: '-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----', name: 'mac',
    });
    h.start();
    await h.receive(challenge);
    await assert.rejects(h.receive(message), /HANDSHAKE_STATE|INVALID_MESSAGE/);
  }
});
