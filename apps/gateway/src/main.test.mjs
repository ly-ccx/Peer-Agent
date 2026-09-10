import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readGatewayConfig } from './main.mjs';
const env = {
  PEER_GATEWAY_ORIGIN: 'https://peer.example', PEER_GATEWAY_OIDC_ISSUER: 'https://id.example/realm',
  PEER_GATEWAY_DATA_DIR: '/tmp/peer-config-test-only', PEER_GATEWAY_OIDC_CLIENT_ID: 'peer',
  PEER_GATEWAY_OIDC_CLIENT_SECRET: 'test-secret', PEER_GATEWAY_OWNER_SUBJECT: 'owner',
};
test('configuration fixes callback and loopback port without embedding a default identity', () => {
  const c = readGatewayConfig(env);
  assert.equal(c.redirectUri, 'https://peer.example/auth/callback');
  assert.equal(c.port, 8787);
  assert.equal(c.allowedSubject, 'owner');
});
for (const field of Object.keys(env)) {
  test(`startup-config-requires-${field}`, () => {
    assert.throws(() => readGatewayConfig({ ...env, [field]: '' }));
  });
}
test('configuration rejects insecure URLs, credentials in origins and malformed paths/ports', () => {
  for (const patch of [
    { PEER_GATEWAY_ORIGIN: 'http://peer.example' },
    { PEER_GATEWAY_ORIGIN: 'https://peer.example/path' },
    { PEER_GATEWAY_OIDC_ISSUER: 'https://user:password@id.example' },
    { PEER_GATEWAY_OIDC_ISSUER: 'https://id.example?token=secret' },
    { PEER_GATEWAY_DATA_DIR: 'relative' },
    { PEER_GATEWAY_PORT: '0' }, { PEER_GATEWAY_PORT: '65536' }, { PEER_GATEWAY_PORT: '12abc' },
  ]) assert.throws(() => readGatewayConfig({ ...env, ...patch }));
});
test('actual CLI exits before discovery/listening with missing configuration and does not leak secrets', () => {
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) if (key.startsWith('PEER_GATEWAY_')) delete clean[key];
  clean.PEER_GATEWAY_OIDC_CLIENT_SECRET = 'never-print-this-secret';
  const result = spawnSync(process.execPath, [new URL('./main.mjs', import.meta.url).pathname], {
    env: clean, encoding: 'utf8', timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Gateway startup failed/);
  assert.equal(result.stderr.includes(clean.PEER_GATEWAY_OIDC_CLIENT_SECRET), false);
  assert.equal(result.stdout, '');
});
