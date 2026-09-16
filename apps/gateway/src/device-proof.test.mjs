import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createDeviceProofVerifier } from './device-proof.mjs';
const pair = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const signature = (message, key = pair.privateKey) => sign(null, Buffer.from(message), key).toString('base64url');

for (const identity of ['correct', 'wrong-key']) {
  for (const state of ['fresh', 'expired', 'disconnected', 'restarted']) {
    test(`proof-${identity}-${state}`, () => {
      let time = 1000;
      const options = { audience: 'https://peer.example', now: () => time };
      let verifier = createDeviceProofVerifier(options);
      const challenge = verifier.issue({ publicKey, connectionId: 'socket-1' });
      const response = { nonce: challenge.nonce, connectionId: 'socket-1',
        signature: signature(challenge.message, identity === 'correct' ? pair.privateKey : other.privateKey) };
      if (state === 'expired') time = challenge.expiresAt;
      if (state === 'disconnected') verifier.disconnect('socket-1');
      if (state === 'restarted') verifier = createDeviceProofVerifier(options);
      assert.equal(verifier.consume(response), identity === 'correct' && state === 'fresh');
      assert.equal(verifier.consume(response), false, 'nonce cannot be replayed');
    });
  }
}

test('proof binds connection and audience, failed attempt consumes nonce', () => {
  const verifier = createDeviceProofVerifier({ audience: 'https://peer.example' });
  for (const tamper of ['connection', 'audience', 'malformed']) {
    const c = verifier.issue({ publicKey, connectionId: 'one' });
    const correct = { nonce: c.nonce, connectionId: 'one', signature: signature(c.message) };
    const bad = { ...correct };
    if (tamper === 'connection') bad.connectionId = 'two';
    if (tamper === 'audience') bad.signature = signature(c.message.replace('peer.example', 'other.example'));
    if (tamper === 'malformed') bad.signature = '!';
    assert.equal(verifier.consume(bad), false);
    assert.equal(verifier.consume(correct), false);
  }
});

test('capacity is bounded; replacement and expiry release old challenges', () => {
  let time = 1;
  const verifier = createDeviceProofVerifier({ audience: 'https://peer.example', now: () => time, capacity: 1 });
  const old = verifier.issue({ publicKey, connectionId: 'one' });
  assert.throws(() => verifier.issue({ publicKey, connectionId: 'two' }), /RATE_LIMITED/);
  const current = verifier.issue({ publicKey, connectionId: 'one' });
  assert.equal(verifier.consume({ nonce: old.nonce, connectionId: 'one', signature: signature(old.message) }), false);
  time = current.expiresAt;
  assert.doesNotThrow(() => verifier.issue({ publicKey, connectionId: 'two' }));
  assert.throws(() => createDeviceProofVerifier({ audience: 'http://peer.example' }), /INVALID_AUDIENCE/);
});
