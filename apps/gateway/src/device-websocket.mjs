import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import { createDeviceAuthenticator } from './device-auth.mjs';
import { createDeviceConnections } from './device-connections.mjs';
import { createDeviceProofVerifier } from './device-proof.mjs';

/** Device enrollment and reconnect transport. No task execution or permission grant. */
export function attachDeviceWebSocket(server, { origin, store, capacity = 1000 }) {
  const base = new URL(origin);
  if (base.protocol !== 'https:' || base.origin !== origin) throw new Error('INVALID_ORIGIN');
  const auth = createDeviceAuthenticator({ store, audience: origin, capacity });
  const enrollmentProofs = createDeviceProofVerifier({ audience: origin, capacity });
  const connections = createDeviceConnections({ store, capacity });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  const exact = (message, fields) => message && typeof message === 'object' && !Array.isArray(message)
    && Object.keys(message).sort().join(',') === fields.sort().join(',');
  const upgrade = (request, socket, head) => {
    const hosts = request.rawHeaders.filter((_, i) => i % 2 === 0).filter(v => v.toLowerCase() === 'host');
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(socket.remoteAddress)
        || hosts.length !== 1 || request.headers.host !== base.host
        || request.url !== '/api/device/ws' || request.method !== 'GET'
        || request.headers.origin || request.headers.cookie || wss.clients.size >= capacity) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
    }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws));
  };
  server.on('upgrade', upgrade);
  wss.on('connection', ws => {
    const connectionId = randomUUID();
    let phase = 'hello'; let handle; let enrollment; let pairing;
    let enrollmentTimeout;
    const timeout = setTimeout(() => ws.terminate(), 10_000);
    timeout.unref();
    ws.on('error', () => ws.terminate());
    ws.on('close', () => {
      clearTimeout(timeout); clearTimeout(enrollmentTimeout);
      auth.disconnect(connectionId); enrollmentProofs.disconnect(connectionId);
      if (handle) connections.disconnect(handle);
    });
    ws.on('message', (data, binary) => {
      try {
        if (binary) throw new Error('BINARY_DENIED');
        const message = JSON.parse(data.toString());
        if (phase === 'hello' && exact(message, ['type', 'protocolVersion', 'publicKey', 'name'])
            && message.type === 'remote.enroll' && message.protocolVersion === 1) {
          if (typeof message.name !== 'string' || !message.name.trim() || message.name.length > 100) throw new Error('INVALID_NAME');
          enrollment = { publicKey: message.publicKey, name: message.name };
          const challenge = enrollmentProofs.issue({ publicKey: message.publicKey, connectionId });
          phase = 'enrollment-proof';
          ws.send(JSON.stringify({ type: 'remote.challenge', ...challenge }));
        } else if (phase === 'enrollment-proof' && exact(message, ['type', 'nonce', 'signature'])
            && message.type === 'remote.proof') {
          if (!enrollmentProofs.consume({ connectionId, nonce: message.nonce, signature: message.signature })) throw new Error('PROOF_DENIED');
          pairing = store.beginPairing(enrollment);
          enrollment = null; phase = 'pairing'; clearTimeout(timeout);
          enrollmentTimeout = setTimeout(() => ws.terminate(), 300_000); enrollmentTimeout.unref();
          ws.send(JSON.stringify({ type: 'remote.pairing', ...pairing }));
        } else if (phase === 'pairing' && exact(message, ['type']) && message.type === 'remote.binding.query') {
          const binding = store.getDeviceBinding(pairing.deviceId);
          if (!binding || binding.revoked) throw new Error('BINDING_DENIED');
          ws.send(JSON.stringify(binding.ownerId
            ? { type: 'remote.binding', deviceId: binding.deviceId, ownerId: binding.ownerId,
              bindingVersion: binding.bindingVersion, status: 'awaiting_device_ack' }
            : { type: 'remote.binding.pending' }));
        } else if (phase === 'pairing' && exact(message, ['type', 'deviceId', 'ownerId', 'bindingVersion'])
            && message.type === 'remote.binding.ack') {
          if (message.deviceId !== pairing.deviceId) throw new Error('BINDING_DENIED');
          const bound = store.acknowledgeBinding(message);
          ws.send(JSON.stringify({ type: 'remote.binding.confirmed', ...bound }));
        } else if (phase === 'hello' && exact(message, ['type', 'protocolVersion', 'deviceId'])
            && message.type === 'remote.hello' && message.protocolVersion === 1) {
          const challenge = auth.begin({ deviceId: message.deviceId, connectionId });
          phase = 'proof';
          ws.send(JSON.stringify({ type: 'remote.challenge', ...challenge }));
        } else if (phase === 'proof' && exact(message, ['type', 'nonce', 'signature']) && message.type === 'remote.proof') {
          const principal = auth.finish({ connectionId, nonce: message.nonce, signature: message.signature });
          if (!store.bindingAcknowledged(principal.deviceId)) {
            // Reconnect may follow a lost enrollment socket or lost ack response.
            // Return binding over the authenticated connection, but do not go online.
            pairing = { deviceId: principal.deviceId };
            phase = 'pairing'; clearTimeout(timeout);
            enrollmentTimeout = setTimeout(() => ws.terminate(), 300_000); enrollmentTimeout.unref();
            ws.send(JSON.stringify({ type: 'remote.binding', deviceId: principal.deviceId,
              ownerId: principal.ownerId, bindingVersion: principal.bindingVersion, status: 'awaiting_device_ack' }));
            return;
          }
          handle = connections.attach(principal, { close: () => ws.terminate() });
          phase = 'online'; clearTimeout(timeout);
          ws.send(JSON.stringify({ type: 'remote.welcome', protocolVersion: 1, connectionEpoch: handle.epoch,
            deviceId: principal.deviceId, ownerId: principal.ownerId, bindingVersion: principal.bindingVersion }));
        } else if (phase === 'online' && exact(message, ['type']) && message.type === 'remote.heartbeat'
            && connections.heartbeat(handle)) {
          ws.send(JSON.stringify({ type: 'remote.heartbeat' }));
        } else throw new Error('MESSAGE_DENIED');
      } catch { ws.terminate(); }
    });
  });
  const sweep = setInterval(() => connections.sweep(), 5000); sweep.unref();
  return {
    connections,
    close() {
      clearInterval(sweep); server.off('upgrade', upgrade); connections.close();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
