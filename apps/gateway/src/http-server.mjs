import { createServer } from 'node:http';
import { attachDeviceWebSocket } from './device-websocket.mjs';

/** Loopback-only backend for a TLS reverse proxy that preserves the configured Host.
 * Forwarded headers never establish identity, origin, or the public request URL.
 * Caller owns authenticated application composition and explicit listen/close.
 */
export function createGatewayHttpServer({ origin, handle, deviceStore, maxBodyBytes = 4096 }) {
  const base = new URL(origin);
  if (base.protocol !== 'https:' || base.origin !== origin || typeof handle !== 'function'
      || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) throw new Error('INVALID_HTTP_CONFIG');
  const server = createServer({ maxHeaderSize: 16_384 }, async (incoming, outgoing) => {
    const fail = status => {
      outgoing.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' });
      outgoing.end(JSON.stringify({ error: status === 413 ? 'BODY_TOO_LARGE' : 'REQUEST_REJECTED' }));
    };
    const remote = incoming.socket.remoteAddress;
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return fail(403);
    const hosts = incoming.rawHeaders.filter((_, index) => index % 2 === 0).filter(h => h.toLowerCase() === 'host');
    if (hosts.length !== 1 || incoming.headers.host !== base.host
        || !incoming.url?.startsWith('/') || incoming.url.startsWith('//')) return fail(400);
    const url = new URL(incoming.url, origin);
    if (url.origin !== origin) return fail(400);
    const length = incoming.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxBodyBytes)) return fail(413);
    try {
      const chunks = []; let size = 0;
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > maxBodyBytes) { fail(413); return; }
        chunks.push(chunk);
      }
      const method = incoming.method ?? 'GET';
      if ((method === 'GET' || method === 'HEAD') && size) return fail(400);
      const headers = new Headers();
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
        const name = incoming.rawHeaders[i];
        if (!['forwarded', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-for'].includes(name.toLowerCase())) {
          headers.append(name, incoming.rawHeaders[i + 1]);
        }
      }
      const response = await handle(new Request(url, { method, headers,
        ...(size ? { body: Buffer.concat(chunks) } : {}) }), { deviceConnections: deviceTransport?.connections });
      outgoing.statusCode = response.status;
      for (const [name, value] of response.headers) if (name !== 'set-cookie') outgoing.setHeader(name, value);
      const cookies = response.headers.getSetCookie();
      if (cookies.length) outgoing.setHeader('set-cookie', cookies);
      outgoing.end(method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()));
    } catch {
      if (!outgoing.headersSent) fail(503); else outgoing.destroy();
    }
  });
  const deviceTransport = deviceStore ? attachDeviceWebSocket(server, { origin, store: deviceStore }) : null;
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.timeout = 15_000;
  server.on('timeout', socket => socket.destroy());
  server.keepAliveTimeout = 5_000;
  return {
    listen(port = 0) {
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('INVALID_PORT');
      return new Promise((resolve, reject) => {
        const onError = error => reject(error);
        server.once('error', onError);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', onError);
          resolve(server.address());
        });
      });
    },
    close() {
      deviceTransport?.close();
      return new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    },
  };
}
