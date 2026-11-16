import assert from 'node:assert/strict';
import test from 'node:test';
import { readModelOAuthTokens, refreshModelOAuthTokens, type ModelOAuthVault } from './model-oauth-refresh.ts';

const key = 'model/account/oauth-tokens';
const old = () => ({ access: 'old-access', refresh: 'old-refresh', expires: 1, unknown: { keep: true } });
const fresh = () => ({ access: 'new-access', refresh: 'new-refresh', expires: Date.now() + 3600000 });
class Vault implements ModelOAuthVault {
  secret: string | null = JSON.stringify(old());
  generation = 1;
  conditional = true;
  loseReceipt = false;
  get revision() { return this.secret === null ? null : String(this.generation).padStart(16, 'A'); }
  getSecret() { return this.secret; }
  supportsModelOAuthCas() { return this.conditional; }
  getSnapshot() { return { secret: this.secret, revision: this.revision }; }
  set(value: unknown) { this.secret = value === null ? null : JSON.stringify(value); this.generation++; }
  compareSet(_key: string, revision: string | null, secret: string | null) {
    if (revision !== this.revision) return false;
    this.secret = secret; this.generation++;
    if (this.loseReceipt && secret && !Object.hasOwn(JSON.parse(secret), 'peerModelRefresh')) throw new Error('receipt_lost');
    return true;
  }
}
function read(client: Vault) { return readModelOAuthTokens<ReturnType<typeof old>>(client, key)!; }
function run(client: Vault, tokens = read(client), refresh = async () => ({ tokens: fresh(), refreshed: true }), validate = () => {}) {
  return refreshModelOAuthTokens({ client, key, authMethod: 'oauth_chatgpt', tokens, refresh, validate });
}
function gate() {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), open: () => resolve() };
}

test('one pre-HTTP owner, preserved unknown fields and fresh receipt for continuation', async () => {
  const client = new Vault();
  const left = read(client), right = read(client);
  const started = gate(), finish = gate(); let requests = 0;
  const first = run(client, left, async () => {
    requests++; started.open(); await finish.promise;
    return { tokens: fresh(), refreshed: true };
  });
  await started.promise;
  assert.equal(JSON.parse(client.secret!).peerModelRefresh.phase, 'in_flight');
  await assert.rejects(run(client, right, async () => { requests++; return { tokens: fresh(), refreshed: true }; }), /credential_oauth_changed/);
  assert.throws(() => read(client), /credential_oauth_refresh_pending/);
  finish.open(); const result = await first;
  assert.equal(requests, 1);
  assert.deepEqual(JSON.parse(client.secret!).unknown, { keep: true });
  assert.equal(Object.hasOwn(JSON.parse(client.secret!), 'peerModelRefresh'), false);
  assert.equal((await run(client, result.tokens as ReturnType<typeof old>)).refreshed, false);
});

test('pre-read generation is invalidated even by writing identical token JSON', async () => {
  const client = new Vault(); const tokens = read(client);
  client.set(old()); let called = false;
  await assert.rejects(run(client, tokens, async () => { called = true; return { tokens: fresh(), refreshed: true }; }), /credential_oauth_changed/);
  assert.equal(called, false);
});

for (const replacement of ['login', 'logout'] as const) {
  test(`late refresh cannot overwrite ${replacement}`, async () => {
    const client = new Vault(); const expected = read(client);
    await assert.rejects(run(client, expected, async () => {
      client.set(replacement === 'login' ? fresh() : null);
      return { tokens: fresh(), refreshed: true };
    }), /credential_oauth_changed/);
    assert.equal(client.secret === null, replacement === 'logout');
    if (replacement === 'login') assert.equal((await run(client)).refreshed, false);
  });
}

for (const failure of ['cancelled', 'timeout', 'http_rejected', 'truncated']) {
  test(`${failure} retains encrypted intent and blocks retry before any remote callback`, async () => {
    const client = new Vault(); let requests = 0;
    await assert.rejects(run(client, read(client), async () => { requests++; throw new Error(failure); }), new RegExp(failure));
    const pending = JSON.parse(client.secret!);
    assert.deepEqual(pending.unknown, { keep: true });
    assert.equal(pending.refresh, old().refresh);
    assert.equal(pending.peerModelRefresh.schemaVersion, 1);
    assert.throws(() => read(client), /credential_oauth_refresh_pending/);
    assert.equal(requests, 1);
  });
}

test('fresh legacy Helper works, expired legacy stops before refresh', async () => {
  const client = new Vault(); client.conditional = false;
  let called = false;
  await assert.rejects(run(client, read(client), async () => { called = true; return { tokens: fresh(), refreshed: true }; }), /credential_oauth_helper_upgrade_required/);
  client.set(fresh()); assert.equal((await run(client)).refreshed, false);
  assert.equal(called, false);
});

test('lost final receipt keeps committed token and next read never repeats refresh', async () => {
  const client = new Vault(); client.loseReceipt = true;
  await assert.rejects(run(client), /receipt_lost/);
  assert.equal(JSON.parse(client.secret!).access, fresh().access);
  assert.equal((await run(client)).refreshed, false);
});

test('configuration change after HTTP preserves unresolved operation instead of publishing', async () => {
  const client = new Vault(); let valid = true;
  await assert.rejects(run(client, read(client), async () => {
    valid = false; return { tokens: fresh(), refreshed: true };
  }, () => { if (!valid) throw new Error('configuration_changed'); }), /configuration_changed/);
  assert.ok(JSON.parse(client.secret!).peerModelRefresh);
});

test('copied or mutated tokens cannot manufacture a snapshot receipt', async () => {
  const client = new Vault(); const tokens = read(client);
  await assert.rejects(run(client, { ...tokens }), /credential_oauth_snapshot_required/);
  tokens.access = 'mutated';
  await assert.rejects(run(client, tokens), /credential_oauth_snapshot_required/);
});

test('unknown pending schemas are retained and never interpreted as fresh access', () => {
  const client = new Vault(); client.set({ ...fresh(), peerModelRefresh: { schemaVersion: 99 } });
  const before = client.secret;
  assert.throws(() => read(client), /credential_oauth_refresh_pending/);
  assert.equal(client.secret, before);
});

test('reservation capacity fails before HTTP without changing the original record', async () => {
  const client = new Vault(); client.set({ ...old(), padding: 'x'.repeat(65400) });
  const before = client.secret; let called = false;
  await assert.rejects(run(client, read(client), async () => { called = true; return { tokens: fresh(), refreshed: true }; }), /credential_oauth_tokens_invalid/);
  assert.equal(called, false); assert.equal(client.secret, before);
});

test('merged token capacity retains pending state instead of committing an unreadable record', async () => {
  const client = new Vault(); client.set({ ...old(), padding: 'x'.repeat(40000) });
  await assert.rejects(run(client, read(client), async () => ({ tokens: { ...fresh(), other: 'y'.repeat(40000) }, refreshed: true })), /credential_oauth_tokens_invalid/);
  assert.ok(JSON.parse(client.secret!).peerModelRefresh);
  assert.equal(JSON.parse(client.secret!).access, old().access);
});
