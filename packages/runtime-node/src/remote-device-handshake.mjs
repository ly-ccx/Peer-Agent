const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...fields].sort().join(',');

/** One connection handshake. Transport must enforce WSS/TLS, size limits and timeouts.
 * sign is supplied by the local credential adapter, not by the remote peer.
 * No tools or PermissionGrant are exposed. Instantiate afresh on each reconnect.
 */
export function createRemoteDeviceHandshake({ origin, deviceId, publicKey, name, store, sign, send, now = Date.now }) {
  if (new URL(origin).origin !== origin || !origin.startsWith('https://') || typeof sign !== 'function'
      || typeof send !== 'function') throw new Error('INVALID_HANDSHAKE_CONFIG');
  let phase = 'initial';
  let expectedDevice = deviceId;
  let stored;
  const enabled = () => {
    const binding = store.load();
    if (binding?.disabled) throw new Error('REMOTE_DISABLED');
    if (binding && (binding.origin !== origin || (expectedDevice && binding.deviceId !== expectedDevice))) {
      throw new Error('BINDING_CONFLICT');
    }
    return binding;
  };
  return {
    start() {
      if (phase !== 'initial') throw new Error('HANDSHAKE_STATE');
      const binding = enabled();
      expectedDevice = binding?.deviceId ?? expectedDevice;
      phase = 'challenge';
      if (expectedDevice) {
        if (!id(expectedDevice)) throw new Error('INVALID_DEVICE');
        send({ type: 'remote.hello', protocolVersion: 1, deviceId: expectedDevice });
      } else {
        if (typeof publicKey !== 'string' || typeof name !== 'string' || !name.trim()) throw new Error('INVALID_DEVICE');
        send({ type: 'remote.enroll', protocolVersion: 1, publicKey, name });
      }
    },
    async receive(message) {
      try {
        enabled();
        if (phase === 'challenge' && exact(message, ['type', 'nonce', 'expiresAt', 'message']) && message.type === 'remote.challenge') {
          const at = now();
          const fields = JSON.parse(message.message);
          if (!Number.isSafeInteger(at) || !Number.isSafeInteger(message.expiresAt)
              || message.expiresAt <= at || message.expiresAt - at > 60_000
              || typeof message.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(message.nonce)
              || !Array.isArray(fields) || fields.length !== 5 || fields[0] !== 'peer-device-proof-v1'
              || fields[1] !== origin || !id(fields[2]) || fields[3] !== message.nonce || fields[4] !== message.expiresAt) {
            throw new Error('INVALID_CHALLENGE');
          }
          phase = 'signing';
          const signature = await sign(message.message);
          enabled();
          if (phase !== 'signing') throw new Error('HANDSHAKE_STATE');
          phase = 'binding';
          send({ type: 'remote.proof', nonce: message.nonce, signature });
          return { status: 'authenticating' };
        }
        if (phase === 'binding' && !expectedDevice && exact(message, ['type', 'challengeId', 'pairingKey', 'deviceId', 'expiresAt'])
            && message.type === 'remote.pairing' && id(message.deviceId) && id(message.challengeId)
            && typeof message.pairingKey === 'string' && /^[A-Za-z0-9_-]{32}$/.test(message.pairingKey)
            && Number.isSafeInteger(message.expiresAt) && message.expiresAt > now()) {
          expectedDevice = message.deviceId;
          return { status: 'pairing', pairing: { ...message } };
        }
        if (phase === 'binding' && expectedDevice && exact(message, ['type']) && message.type === 'remote.binding.pending') {
          return { status: 'pending' };
        }
        if (phase === 'binding' && exact(message, ['type', 'deviceId', 'ownerId', 'bindingVersion', 'status'])
            && message.type === 'remote.binding' && message.status === 'awaiting_device_ack'
            && message.deviceId === expectedDevice && id(message.ownerId)
            && Number.isSafeInteger(message.bindingVersion) && message.bindingVersion > 0) {
          // Synchronous durable save must finish before any acknowledgement leaves the host.
          stored = store.save({ origin, deviceId: expectedDevice, ownerId: message.ownerId, bindingVersion: message.bindingVersion });
          enabled();
          phase = 'confirming';
          send({ type: 'remote.binding.ack', deviceId: stored.deviceId, ownerId: stored.ownerId, bindingVersion: stored.bindingVersion });
          return { status: 'saved' };
        }
        if (phase === 'confirming' && exact(message, ['type', 'deviceId', 'ownerId', 'bindingVersion', 'status'])
            && message.type === 'remote.binding.confirmed' && message.status === 'bound'
            && message.deviceId === stored.deviceId && message.ownerId === stored.ownerId && message.bindingVersion === stored.bindingVersion) {
          phase = 'done'; return { status: 'reconnect' };
        }
        if (phase === 'binding' && exact(message, ['type', 'protocolVersion', 'connectionEpoch', 'deviceId', 'ownerId', 'bindingVersion'])
            && message.type === 'remote.welcome' && message.protocolVersion === 1
            && Number.isSafeInteger(message.connectionEpoch) && message.connectionEpoch > 0) {
          const binding = enabled();
          if (!binding || message.deviceId !== binding.deviceId || message.ownerId !== binding.ownerId
              || message.bindingVersion !== binding.bindingVersion) throw new Error('BINDING_CONFLICT');
          phase = 'done'; return { status: 'online', connectionEpoch: message.connectionEpoch };
        }
        throw new Error('HANDSHAKE_STATE');
      } catch (error) { phase = 'failed'; throw error; }
    },
  };
}
