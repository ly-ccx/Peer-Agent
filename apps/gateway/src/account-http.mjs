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
  // CSP `form-action` is re-checked on the redirect hop of a form submission, so the
  // identity provider's origin must be allowed or the browser cancels the login
  // redirect and the page silently stays on the form. The surface always adds
  // `'self'`, so only a genuinely different issuer origin needs listing. Taken from
  // login.issuer to keep one source of truth with what login actually redirects to.
  const issuerOrigin = (() => {
    try { return new URL(login?.issuer).origin; } catch { return ''; }
  })();
  const formActionOrigins = issuerOrigin && issuerOrigin !== origin ? [issuerOrigin] : [];
  // Bounded per-account admission; source limits additionally belong at the listener/proxy.
  const pairingAttempts = new Map();
  const reply = (status, body, extra = {}) => new Response(body === null ? null : JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'", ...extra },
  });
  /** Bounded JSON body. Reports an oversized body instead of throwing, so a bad
   * request becomes a status code rather than a 503. */
  const readJsonBody = async (request, maxBytes) => {
    const reader = request.body?.getReader();
    if (!reader) return null;
    const chunks = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) { await reader.cancel(); return { tooLarge: true }; }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
  };
  // Routing failures are stable codes the page can explain. The device's own
  // verdict passes through unchanged; an unrecognised code never becomes 200.
  const TASK_ERROR_STATUS = {
    INVALID_REQUEST: 400, RATE_LIMITED: 429,
    DEVICE_OFFLINE: 409, REQUEST_EXPIRED: 409,
    DEVICE_UNAVAILABLE: 503, DELEGATION_UNAVAILABLE: 503,
    DELEGATION_EXPIRED: 403, WORKSPACE_DENIED: 403, CAPABILITY_DENIED: 403,
    TASK_DENIED: 403, IDENTITY_UNBOUND: 403, EXPORT_DENIED: 403,
    OUTCOME_UNKNOWN: 504,
  };
  return async function handle(request, { deviceConnections, deviceTasks } = {}) {
    const url = new URL(request.url);
    if (url.origin !== origin || (request.headers.has('host') && request.headers.get('host') !== base.host)) {
      return reply(400, { error: 'INVALID_HOST' });
    }
    // No CORS: mutations and login initiation require exact browser Origin.
    if (request.method !== 'GET' && request.headers.get('origin') !== origin) return reply(403, { error: 'ORIGIN_DENIED' });
    try {
      if (request.method === 'GET') {
        const surface = remoteWebResponse(url.pathname, { formActionOrigins });
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
        const body = await readJsonBody(request, 4096);
        if (body?.tooLarge) return reply(413, { error: 'BODY_TOO_LARGE' });
        if (!body || Array.isArray(body) || typeof body !== 'object'
            || Object.keys(body).sort().join(',') !== 'challengeId,pairingKey'
            || typeof body.challengeId !== 'string' || typeof body.pairingKey !== 'string') {
          return reply(400, { error: 'INVALID_REQUEST' });
        }
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
      if (url.pathname === '/api/delegations' && request.method === 'GET') {
        // Read-only view of what each online device published, so the page can
        // offer real workspace IDs instead of asking the user to guess them.
        const principal = sessions.authenticate(cookie(request.headers, SESSION));
        if (!principal) return reply(401, { error: 'AUTH_REQUIRED' });
        if (!deviceTasks) return reply(200, { delegations: [] });
        return reply(200, { delegations: devices.listDevices(principal.ownerId)
          .filter(device => !device.revoked)
          .map(device => ({ deviceId: device.deviceId, name: device.name, delegation: deviceTasks.describe(principal.ownerId, device.deviceId) }))
          .filter(entry => entry.delegation) });
      }
      if (url.pathname === '/api/tasks/read' && request.method === 'POST') {
        // Read-only task routing. Nothing is queued: an offline device is refused,
        // and a sent-but-unanswered request is reported as unknown, never as failed.
        const principal = sessions.authenticate(cookie(request.headers, SESSION));
        if (!principal) return reply(401, { error: 'AUTH_REQUIRED' });
        if (!deviceTasks) return reply(503, { error: 'SERVICE_UNAVAILABLE' });
        if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
          return reply(415, { error: 'JSON_REQUIRED' });
        }
        const body = await readJsonBody(request, 4096);
        if (body?.tooLarge) return reply(413, { error: 'BODY_TOO_LARGE' });
        if (!body || Array.isArray(body) || typeof body !== 'object'
            || Object.keys(body).sort().join(',') !== 'deviceId,taskId,workspaceId'
            || typeof body.deviceId !== 'string' || typeof body.workspaceId !== 'string'
            || typeof body.taskId !== 'string') {
          return reply(400, { error: 'INVALID_REQUEST' });
        }
        try {
          const answer = await deviceTasks.submit({ ownerId: principal.ownerId, deviceId: body.deviceId,
            workspaceId: body.workspaceId, taskId: body.taskId });
          return reply(200, { requestId: answer.requestId, status: answer.status, result: answer.result ?? null });
        } catch (error) {
          const code = typeof error?.message === 'string' && /^[A-Z][A-Z_]{0,63}$/.test(error.message)
            ? error.message : 'UNKNOWN';
          return reply(TASK_ERROR_STATUS[code] ?? 502, { error: 'TASK_UNAVAILABLE', code });
        }
      }
      return reply(404, { error: 'NOT_FOUND' });
    } catch {
      // Never serialize IdP errors, codes, tokens or storage paths into public responses.
      return reply(503, { error: 'SERVICE_UNAVAILABLE' });
    }
  };
}
