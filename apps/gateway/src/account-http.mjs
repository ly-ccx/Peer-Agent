import { remoteWebResponse } from './web-surface.mjs';

const SESSION = '__Host-peer_session';
const LOGIN = '__Host-peer_login';
function cookie(headers, name) {
  const matches = (headers.get('cookie') ?? '').split(';').map(v => v.trim()).filter(v => v.startsWith(`${name}=`));
  return matches.length === 1 ? matches[0].slice(name.length + 1) : null;
}
const setCookie = (name, value, maxAge) => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;

/** Fetch-style HTTP adapter. The server must reconstruct URLs from configured origin,
 * validate the incoming Host, and must not trust arbitrary forwarded headers.
 * No listener, proxy, development auth bypass, or tool execution is created here.
 */
export function createAccountHttp({ origin, login, sessions, devices, now = Date.now }) {
  const base = new URL(origin);
  if (base.protocol !== 'https:' || base.origin !== origin) throw new Error('INVALID_ORIGIN');
  // Bounded per-account admission; source limits additionally belong at the listener/proxy.
  const pairingAttempts = new Map();
  const reply = (status, body, extra = {}) => new Response(body === null ? null : JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'", ...extra },
  });
  return async function handle(request, { deviceConnections } = {}) {
    const url = new URL(request.url);
    if (url.origin !== origin || (request.headers.has('host') && request.headers.get('host') !== base.host)) {
      return reply(400, { error: 'INVALID_HOST' });
    }
    // No CORS: mutations and login initiation require exact browser Origin.
    if (request.method !== 'GET' && request.headers.get('origin') !== origin) return reply(403, { error: 'ORIGIN_DENIED' });
    try {
      if (request.method === 'GET') {
        const surface = remoteWebResponse(url.pathname);
        if (surface) return surface;
      }
      if (url.pathname === '/auth/login' && request.method === 'POST') {
        const start = await login.begin();
        return reply(303, null, { location: start.url,
          'set-cookie': setCookie(LOGIN, start.browserBinding, 300) });
      }
      if (url.pathname === '/auth/callback' && request.method === 'GET') {
        try {
          const identity = await login.finish(url.href, cookie(request.headers, LOGIN));
          const previous = cookie(request.headers, SESSION);
          const session = sessions.issue(identity);
          if (previous) sessions.revoke(previous);
          const response = reply(303, null, { location: '/devices' });
          response.headers.append('set-cookie', setCookie(LOGIN, '', 0));
          response.headers.append('set-cookie', setCookie(SESSION, session.token, Math.max(0, Math.floor((session.expiresAt - now()) / 1000))));
          return response;
        } catch {
          return reply(401, { error: 'LOGIN_DENIED' }, { 'set-cookie': setCookie(LOGIN, '', 0) });
        }
      }
      if (url.pathname === '/auth/logout' && request.method === 'POST') {
        sessions.revoke(cookie(request.headers, SESSION));
        return reply(204, null, { 'set-cookie': setCookie(SESSION, '', 0) });
      }
      if (url.pathname === '/api/pairings/claim' && request.method === 'POST') {
        const principal = sessions.authenticate(cookie(request.headers, SESSION));
        if (!principal) return reply(401, { error: 'AUTH_REQUIRED' });
        const time = now();
        if (!Number.isSafeInteger(time) || time < 0) throw new Error('INVALID_CLOCK');
        for (const [id, value] of pairingAttempts) if (value.until <= time) pairingAttempts.delete(id);
        let attempt = pairingAttempts.get(principal.ownerId);
        if (!attempt) {
          if (pairingAttempts.size >= 1000) return reply(429, { error: 'RATE_LIMITED' });
          attempt = { count: 0, until: time + 60_000 };
          pairingAttempts.set(principal.ownerId, attempt);
        }
        if (++attempt.count > 10) return reply(429, { error: 'RATE_LIMITED' });
        if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
          return reply(415, { error: 'JSON_REQUIRED' });
        }
        let body;
        try {
          const reader = request.body?.getReader();
          if (!reader) return reply(400, { error: 'INVALID_REQUEST' });
          const chunks = []; let size = 0;
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > 4096) { await reader.cancel(); return reply(413, { error: 'BODY_TOO_LARGE' }); }
              chunks.push(value);
            }
          } finally { reader.releaseLock(); }
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!body || Array.isArray(body) || typeof body !== 'object'
              || Object.keys(body).sort().join(',') !== 'challengeId,pairingKey'
              || typeof body.challengeId !== 'string' || typeof body.pairingKey !== 'string') {
            return reply(400, { error: 'INVALID_REQUEST' });
          }
        } catch { return reply(400, { error: 'INVALID_REQUEST' }); }
        try {
          return reply(202, devices.claimPairing(principal.ownerId, body.challengeId, body.pairingKey));
        } catch (error) {
          if (error.message === 'PAIRING_INVALID') return reply(400, { error: 'PAIRING_INVALID' });
          throw error;
        }
      }
      if (url.pathname === '/api/devices' && request.method === 'GET') {
        const principal = sessions.authenticate(cookie(request.headers, SESSION));
        if (!principal) return reply(401, { error: 'AUTH_REQUIRED' });
        const list = devices.listDevices(principal.ownerId);
        return reply(200, { devices: list.map(device => {
          if (!deviceConnections) return device;
          let online = false;
          if (!device.revoked) {
            try { deviceConnections.resolve(principal.ownerId, device.deviceId); online = true; }
            catch (error) {
              if (!['DEVICE_OFFLINE', 'DEVICE_UNAVAILABLE'].includes(error.message)) throw error;
            }
          }
          return { ...device, online };
        }) });
      }
      return reply(404, { error: 'NOT_FOUND' });
    } catch {
      // Never serialize IdP errors, codes, tokens or storage paths into public responses.
      return reply(503, { error: 'SERVICE_UNAVAILABLE' });
    }
  };
}
