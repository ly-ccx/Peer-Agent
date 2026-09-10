import { createPublicKey, randomBytes, verify } from 'node:crypto';

/** Connection-local proof challenges. Recreate on Gateway restart: old proofs fail closed.
 * Caller supplies the registered key for reconnect, not a key from the response.
 * This proves possession only; check binding/revocation before establishing a session.
 */
export function createDeviceProofVerifier({ audience, now = Date.now, capacity = 1000 } = {}) {
  if (typeof audience !== 'string' || !audience.startsWith('https://')
      || new URL(audience).origin !== audience) throw new Error('INVALID_AUDIENCE');
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('INVALID_CAPACITY');
  const pending = new Map();
  const clock = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('INVALID_CLOCK');
    return value;
  };
  return {
    issue({ publicKey, connectionId }) {
      if (typeof connectionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(connectionId)
          || typeof publicKey !== 'string' || publicKey.length > 4096) throw new Error('INVALID_PROOF_REQUEST');
      const key = createPublicKey(publicKey);
      if (key.asymmetricKeyType !== 'ed25519') throw new Error('INVALID_DEVICE_KEY');
      const time = clock();
      for (const [nonce, record] of pending) {
        if (record.expiresAt <= time || record.connectionId === connectionId) pending.delete(nonce);
      }
      if (pending.size >= capacity) throw new Error('RATE_LIMITED');
      const nonce = randomBytes(32).toString('base64url');
      const expiresAt = time + 60_000;
      const message = JSON.stringify(['peer-device-proof-v1', audience, connectionId, nonce, expiresAt]);
      pending.set(nonce, { key, connectionId, expiresAt, message });
      return { nonce, expiresAt, message };
    },
    consume({ nonce, connectionId, signature }) {
      const time = clock();
      const record = pending.get(nonce);
      // A response always consumes its nonce, even on failure.
      pending.delete(nonce);
      if (!record || record.expiresAt <= time || record.connectionId !== connectionId
          || typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
      return verify(null, Buffer.from(record.message), record.key, Buffer.from(signature, 'base64url'));
    },
    disconnect(connectionId) {
      for (const [nonce, record] of pending) if (record.connectionId === connectionId) pending.delete(nonce);
    },
  };
}
