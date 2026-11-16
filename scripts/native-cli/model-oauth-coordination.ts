import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { withModelConfigLock } from '../../packages/runtime-node/src/model-config-file.mjs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { CredentialHelperClient, createSubprocessCredentialTransport } from '../../packages/credential-helper/src/index.ts';
import { createLlmConfigStore } from '../../apps/desktop/electron/main/llm-config-store.mjs';
import { resolveProviderCredential } from '../../apps/desktop/electron/main/provider-credential-resolver.mjs';
import { ensureFreshTokens } from '../../apps/desktop/electron/main/llm-oauth/openai-oauth.mjs';
import { ensureFreshGoogleTokens } from '../../apps/desktop/electron/main/llm-oauth/google-oauth.mjs';
import { DEFAULT_SUBSCRIPTION_MODEL } from '../../apps/desktop/electron/main/provider-adapters/openai-model-catalog.mjs';
import { createTuiSharedModelCredentialStore } from '../../apps/tui/src/model-credential-store.ts';
import { loadSharedModelSelection } from '../../packages/runtime-node/dist/models-public.js';

function gate() {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), open: () => resolve() };
}
const home = mkdtempSync(join(tmpdir(), 'peer-model-oauth-coordination-'));
let requests = 0;
let status = 200;
let started = gate(), finish = gate();
const server = createServer(async (request, response) => {
  assert.equal(request.method, 'POST');
  let body = ''; for await (const chunk of request) body += chunk;
  assert.equal(new URLSearchParams(body).get('grant_type'), 'refresh_token');
  requests++; started.open(); await finish.promise;
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(status === 200
    ? { access_token: 'refreshed-access', refresh_token: 'refreshed-refresh', expires_in: 3600 }
    : { error: 'synthetic_rejection' }));
});
try {
  writeFileSync(join(home, '.native-cli-fixture'), 'isolated');
  writeFileSync(join(home, '.synthetic-vault-key'), Buffer.alloc(32, 17), { mode: 0o600 });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/token`;
  const client = new CredentialHelperClient(createSubprocessCredentialTransport({
    explicitPath: resolve('target/debug/examples/vault-fixture'), dataHome: home,
  }));
  // Assert actual production Desktop/TUI writes own the same configuration
  // directory lock as Rust. Direct fixture setup still uses the raw client.
  let guardedCas = 0;
  const guardedClient = new Proxy(client, { get(target, property) {
    const value = Reflect.get(target, property, target);
    if (property === 'compareSet') return (...args: Parameters<typeof client.compareSet>) => {
      assert.ok(existsSync(join(home, 'llm-providers.json.lock')), 'host CAS must own the shared configuration lock');
      guardedCas++;
      return target.compareSet(...args);
    };
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const store = createLlmConfigStore({ configFile: join(home, 'llm-providers.json'), credentialClient: guardedClient });
  const model = store.addProvider({ provider: 'openai', channelId: 'openai', authMethod: 'oauth_chatgpt', groupId: 'fixture', model: DEFAULT_SUBSCRIPTION_MODEL });
  const key = 'model/fixture/oauth-tokens';
  const old = { access: 'old', refresh: 'old-refresh', expires: 1, accountId: 'account', unknown: { preserved: true } };
  const fresh = { ...old, access: 'new-login', refresh: 'new-login-refresh', expires: Date.now() + 3600000 };
  const callback = (tokens: any) => ensureFreshTokens(tokens, { fetchImpl: (_url: string, init: RequestInit) => fetch(url, { ...init, signal: AbortSignal.timeout(5000) }) });
  const renew = (tokens: any) => store.refreshOAuthTokens(model.id, tokens, callback);
  const credential = () => store.getCredential(model.id).tokens;
  const reset = () => { client.setSecret(key, JSON.stringify(old)); started = gate(); finish = gate(); status = 200; };
  const waitStarted = () => Promise.race([started.promise, new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture_http_not_started')), 5000); timer.unref();
  })]);

  if (process.argv.includes('--baseline')) {
    // Run the actual prior resolver, preserving its relative production imports.
    let source = execFileSync('git', ['show', '505ac8e4e7128ea7c270b4118e9438bbf3caddfa:apps/desktop/electron/main/provider-credential-resolver.mjs'], { encoding: 'utf8' });
    const base = pathToFileURL(resolve('apps/desktop/electron/main') + '/');
    source = source.replace(/from '([^']+)'/g, (_all, specifier) => `from '${new URL(specifier, base).href}'`);
    const baseline = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    const runRace = async (resolver: typeof resolveProviderCredential) => {
      reset(); finish.open(); const before = requests;
      const preReadThenNativeClaim = { ...store, getCredential(id: string) {
        const value = store.getCredential(id);
        const snapshot = client.getSnapshot(key);
        client.compareSet(key, snapshot.revision, JSON.stringify({ ...old, peerModelRefresh: {
          schemaVersion: 1, attemptId: '11111111-1111-4111-8111-111111111111', authMethod: 'oauth_chatgpt', phase: 'in_flight', createdAt: Date.now(),
        } }));
        return value;
      } };
      await assert.rejects(resolver({ provider: model, llmConfigStore: preReadThenNativeClaim, ensureFreshChatGptTokens: callback }));
      return requests - before;
    };
    const priorRequests = await runRace(baseline.resolveProviderCredential);
    const fixedRequests = await runRace(resolveProviderCredential);
    assert.equal(priorRequests, 1); assert.equal(fixedRequests, 0);
    console.log(JSON.stringify({ baselineCommit: '505ac8e4', case: 'pre-read-then-native-reservation', priorDuplicateHttpRequests: priorRequests, candidateDuplicateHttpRequests: fixedRequests }));
  }

  reset();
  const left = credential(), right = credential();
  const first = renew(left); await waitStarted();
  withModelConfigLock(join(home,'llm-providers.json'),()=>{});
  const before = requests;
  await assert.rejects(renew(right), /credential_oauth_changed/);
  assert.equal(requests, before);
  assert.throws(credential, /credential_oauth_refresh_pending/);
  finish.open(); const result = await first;
  assert.equal(result.tokens.access, 'refreshed-access');
  assert.deepEqual(JSON.parse(client.getSecret(key)!).unknown, old.unknown);
  assert.equal((await renew(result.tokens)).refreshed, false);

  reset(); const preRead = credential(); client.setSecret(key, JSON.stringify(old));
  await assert.rejects(renew(preRead), /credential_oauth_changed/);

  for (const replacement of ['login', 'logout', 'disabled', 'unknown-http', 'lost-receipt']) {
    reset();
    if (replacement === 'unknown-http') status = 500;
    const pending = renew(credential()); await waitStarted();
    const rejection = assert.rejects(pending);
    if (replacement === 'login') store.setOAuthTokens(model.id, fresh, { allowPending: true });
    if (replacement === 'logout') client.deleteSecret(key);
    if (replacement === 'disabled') store.updateProvider(model.id, { enabled: false });
    if (replacement === 'lost-receipt') writeFileSync(join(home, '.lose-compare-receipt'), 'once');
    finish.open(); await rejection;
    if (replacement === 'login') assert.deepEqual(JSON.parse(client.getSecret(key)!), fresh);
    else if (replacement === 'logout') assert.equal(client.getSecret(key), null);
    else if (replacement === 'lost-receipt') assert.equal(credential().access, 'refreshed-access');
    else {
      const value = JSON.parse(client.getSnapshot(key).secret!);
      assert.ok(value.peerModelRefresh); assert.deepEqual(value.unknown, old.unknown);
      assert.throws(credential, /credential_oauth_refresh_pending/);
    }
    if (replacement === 'disabled') store.updateProvider(model.id, { enabled: true });
    store.setOAuthTokens(model.id, fresh, { allowPending: true });
    assert.equal((await renew(credential())).refreshed, false);
  }

  // Public production resolver with real Google refresh form and encrypted Vault.
  const google = store.addProvider({ provider: 'google', channelId: 'gemini', authMethod: 'oauth_google', groupId: 'google', model: 'gemini-2.5-pro' });
  client.setSecret('model/google/oauth-tokens', JSON.stringify({ ...old, provider: 'google' }));
  started = gate(); finish = gate(); finish.open(); status = 200;
  const resolved = await resolveProviderCredential({ provider: google, llmConfigStore: store,
    ensureFreshGeminiTokens: (tokens: any) => ensureFreshGoogleTokens(tokens, { fetchImpl: (_url: string, init: RequestInit) => fetch(url, { ...init, signal: AbortSignal.timeout(5000) }) }),
  });
  assert.equal(resolved.apiKey, 'refreshed-access');
  assert.deepEqual(JSON.parse(client.getSecret('model/google/oauth-tokens')!).unknown, old.unknown);
  const tuiCredentials = createTuiSharedModelCredentialStore({ dataHome: home, client: guardedClient });
  const tuiSelection = () => {
    const value = loadSharedModelSelection({ userDataPath: home, credentialId: 'fixture', credentialStore: tuiCredentials });
    assert.ok(value?.oauthTokens); return value;
  };
  reset(); const tui = tuiSelection();
  // Narrow public token views retain their original Vault generation, while
  // unknown encrypted fields survive renewal and are not exposed in that view.
  assert.equal(Object.hasOwn(tui.oauthTokens!, 'unknown'), false);
  const tuiPending = tui.refreshOAuthTokens(tui.oauthTokens!, callback); await waitStarted();
  assert.throws(credential, /credential_oauth_refresh_pending/);
  finish.open(); const tuiResult = await tuiPending;
  assert.equal(tuiResult.tokens.access, 'refreshed-access');
  assert.equal(Object.hasOwn(tuiResult.tokens, 'unknown'), false);
  assert.deepEqual(JSON.parse(client.getSecret(key)!).unknown, old.unknown);
  assert.equal((await tui.refreshOAuthTokens(tuiResult.tokens, callback)).refreshed, false);
  reset(); const staleTui = tuiSelection(); client.setSecret(key, JSON.stringify(old));
  await assert.rejects(staleTui.refreshOAuthTokens(staleTui.oauthTokens!, callback), /credential_oauth_changed/);
  reset(); const staleConfig = tuiSelection(); store.updateProvider(model.id, { enabled: false });
  await assert.rejects(staleConfig.refreshOAuthTokens(staleConfig.oauthTokens!, callback), /credential_oauth_configuration_changed/);
  store.updateProvider(model.id, { enabled: true });
  assert.ok(readFileSync(join(home, 'credentials.vault.json')).length);
  assert.ok(guardedCas >= 10, 'actual Desktop and TUI refresh CAS calls must use the guarded client');
  console.log(JSON.stringify({configurationGuardedVaultCas:guardedCas,httpWaitReleasedConfigLock:true}));
  console.log('Actual Desktop/TUI/SharedSelection -> encrypted Rust Vault pre-dispatch refresh, HTTP, late login/logout, unknown outcome, recovery, narrow-view generation and Google resolver passed.');
} finally {
  finish.open(); server.closeAllConnections();
  await new Promise<void>(done => server.close(() => done()));
  rmSync(home, { recursive: true, force: true });
}
