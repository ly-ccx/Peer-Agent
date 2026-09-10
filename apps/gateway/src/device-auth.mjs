import { createDeviceProofVerifier } from './device-proof.mjs';

/** Registered-device authentication only. Transport must generate connectionId itself.
 * Result is a server-side principal snapshot, NOT a bearer token, online lease or grant.
 * Routing must recheck current binding/version on every request.
 */
export function createDeviceAuthenticator({ store, audience, now = Date.now, capacity = 1000 }) {
  const proofs = createDeviceProofVerifier({ audience, now, capacity });
  const pending = new Map();
  const active = row => row && row.ownerId && !row.revoked;
  return {
    begin({ deviceId, connectionId }) {
      const binding = store.getDeviceBinding(deviceId);
      if (!active(binding)) throw new Error('DEVICE_AUTH_DENIED');
      const time = now();
      for (const [connection, record] of pending) {
        if (record.expiresAt <= time || connection === connectionId) {
          pending.delete(connection); proofs.disconnect(connection);
        }
      }
      const challenge = proofs.issue({ publicKey: binding.publicKey, connectionId });
      pending.set(connectionId, { ...binding, ...challenge });
      return challenge;
    },
    finish({ connectionId, nonce, signature }) {
      const expected = pending.get(connectionId);
      pending.delete(connectionId);
      if (!expected || expected.nonce !== nonce) {
        proofs.disconnect(connectionId);
        throw new Error('DEVICE_AUTH_DENIED');
      }
      if (!proofs.consume({ connectionId, nonce, signature })) throw new Error('DEVICE_AUTH_DENIED');
      const current = store.getDeviceBinding(expected.deviceId);
      if (!active(current) || current.ownerId !== expected.ownerId
          || current.bindingVersion !== expected.bindingVersion || current.publicKey !== expected.publicKey) {
        throw new Error('DEVICE_AUTH_DENIED');
      }
      return Object.freeze({ deviceId: current.deviceId, ownerId: current.ownerId,
        bindingVersion: current.bindingVersion, connectionId });
    },
    disconnect(connectionId) { pending.delete(connectionId); proofs.disconnect(connectionId); },
  };
}
