import { mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverAccountLogin } from './account-login.mjs';
import { createAccountSessions } from './account-sessions.mjs';
import { createDeviceStore } from './device-store.mjs';
import { createAccountHttp } from './account-http.mjs';
import { createGatewayHttpServer } from './http-server.mjs';

/** Single-owner deployment configuration. No default owner or development auth. */
export function readGatewayConfig(env) {
  const required = name => {
    const value = env[name];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing ${name}`);
    return value;
  };
  const origin = required('PEER_GATEWAY_ORIGIN');
  const issuer = required('PEER_GATEWAY_OIDC_ISSUER');
  for (const [name, value] of [['origin', origin], ['issuer', issuer]]) {
    let url;
    try { url = new URL(value); } catch { throw new Error(`Invalid ${name}`); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
        || (name === 'origin' && url.origin !== value)) throw new Error(`Invalid ${name}`);
  }
  const dataDir = required('PEER_GATEWAY_DATA_DIR');
  if (!isAbsolute(dataDir)) throw new Error('PEER_GATEWAY_DATA_DIR must be absolute');
  const portText = env.PEER_GATEWAY_PORT ?? '8787';
  if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) throw new Error('Invalid gateway port');
  return Object.freeze({ origin, issuer, dataDir, port: Number(portText),
    clientId: required('PEER_GATEWAY_OIDC_CLIENT_ID'),
    clientSecret: required('PEER_GATEWAY_OIDC_CLIENT_SECRET'),
    allowedSubject: required('PEER_GATEWAY_OWNER_SUBJECT'),
    redirectUri: `${origin}/auth/callback`,
  });
}

/** Real discovery completes before opening databases or listening. */
export async function startGateway(env = process.env) {
  const config = readGatewayConfig(env);
  const login = await discoverAccountLogin(config);
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  let sessions;
  let devices;
  let server;
  try {
    sessions = createAccountSessions(join(config.dataDir, 'sessions.sqlite'));
    devices = createDeviceStore(join(config.dataDir, 'devices.sqlite'));
    const handle = createAccountHttp({ origin: config.origin, login, sessions, devices });
    server = createGatewayHttpServer({ origin: config.origin, handle, deviceStore: devices });
    const address = await server.listen(config.port);
    let closing;
    return { address, close() {
      closing ??= (async () => {
        try { await server.close(); } finally { devices.close(); sessions.close(); }
      })();
      return closing;
    } };
  } catch (error) {
    devices?.close(); sessions?.close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // New SQLite/WAL files must not be group/world-readable.
  process.umask(0o077);
  try {
    const gateway = await startGateway();
    console.log(`Gateway account API listening on loopback port ${gateway.address.port}; device routing is not yet available.`);
    const stop = () => { gateway.close().catch(() => { process.exitCode = 1; }); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch {
    // Discovery errors may contain provider responses: never print tokens/config.
    console.error('Gateway startup failed. Check required configuration, OIDC discovery, data directory and loopback port.');
    process.exitCode = 1;
  }
}
