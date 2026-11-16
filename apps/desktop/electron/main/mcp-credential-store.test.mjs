import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createMcpCredentialStore, resolveMcpCredentialInjection } from './mcp-credential-store.mjs';

let tmpDir;
let secrets;

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
  decryptString: (value) => Buffer.from(value).toString('utf8').replace(/^encrypted:/, ''),
};

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'mcp-credential-store-'));
  secrets = new Map();
});

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

function createStore() {
  return createMcpCredentialStore({
    credentialFile: path.join(tmpDir, 'mcp-credentials.json'),
    safeStorage: fakeSafeStorage,
    credentialClient: {
      setSecret: (key, secret) => secrets.set(key, secret),
      getSecret: (key) => secrets.get(key) ?? null,
    },
  });
}

describe('MCP credential store', () => {
  it('stores encrypted credential values and returns only redacted metadata', () => {
    const store = createStore();
    const credential = store.putCredential({
      label: 'GitHub MCP token',
      kind: 'http_bearer',
      secret: 'ghp_super_secret_token',
    });

    assert.equal(credential.kind, 'http_bearer');
    assert.equal(credential.lastFour, 'oken');
    assert.equal(credential.storage, 'vault');
    assert.ok(credential.credentialRef.startsWith('mcp-cred:'));
    assert.equal('secret' in credential, false);

    const persisted = readFileSync(path.join(tmpDir, 'mcp-credentials.json'), 'utf8');
    assert.equal(persisted.includes('ghp_super_secret_token'), false);
    assert.equal(persisted.includes('encrypted:'), false);

    const resolved = store.resolveSecret(credential.credentialRef);
    assert.equal(resolved.secret, 'ghp_super_secret_token');
  });

  it('injects HTTP bearer credentials as Authorization headers', async () => {
    const store = createStore();
    const credential = store.putCredential({
      label: 'Bearer',
      kind: 'http_bearer',
      secret: 'bearer-secret',
    });

    const injection = await resolveMcpCredentialInjection(store, {
      mode: 'http_bearer',
      credentialRef: credential.credentialRef,
    }, { transport: 'streamable_http' });

    assert.deepEqual(injection.headers, { Authorization: 'Bearer bearer-secret' });
    assert.deepEqual(injection.env, {});
    assert.equal(injection.authContext.mode, 'http_bearer');
    assert.equal(injection.authContext.hasCredential, true);
  });

  it('injects custom HTTP header credentials', async () => {
    const store = createStore();
    const credential = store.putCredential({
      label: 'API key',
      kind: 'http_header',
      headerName: 'X-API-Key',
      secret: 'api-key-secret',
    });

    const injection = await resolveMcpCredentialInjection(store, {
      mode: 'http_header',
      credentialRef: credential.credentialRef,
      headerName: 'X-API-Key',
    }, { transport: 'sse' });

    assert.deepEqual(injection.headers, { 'X-API-Key': 'api-key-secret' });
    assert.equal(injection.authContext.headerName, 'X-API-Key');
  });

  it('injects stdio credentials as process environment variables only for stdio transports', async () => {
    const store = createStore();
    const credential = store.putCredential({
      label: 'stdio env',
      kind: 'stdio_env',
      envName: 'GITHUB_PERSONAL_ACCESS_TOKEN',
      secret: 'stdio-secret',
    });

    const injection = await resolveMcpCredentialInjection(store, {
      mode: 'stdio_env',
      credentialRef: credential.credentialRef,
      envName: 'GITHUB_PERSONAL_ACCESS_TOKEN',
    }, { transport: 'stdio' });

    assert.deepEqual(injection.headers, {});
    assert.deepEqual(injection.env, { GITHUB_PERSONAL_ACCESS_TOKEN: 'stdio-secret' });
    assert.equal(injection.authContext.envName, 'GITHUB_PERSONAL_ACCESS_TOKEN');

    await assert.rejects(
      () => resolveMcpCredentialInjection(store, {
        mode: 'stdio_env',
        credentialRef: credential.credentialRef,
        envName: 'GITHUB_PERSONAL_ACCESS_TOKEN',
      }, { transport: 'streamable_http' }),
      /requires a stdio MCP transport/,
    );
  });

  it('stores OAuth tokens encrypted and exposes only token status in metadata', async () => {
    const store = createStore();
    const credential = store.putCredential({
      label: 'OAuth MCP',
      kind: 'oauth2',
      oauth: {
        authorizationServerUrl: 'https://auth.example.com',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        scopes: ['mcp.read'],
        redirectUrl: 'http://127.0.0.1:33418/mcp/oauth/callback',
      },
    });

    assert.equal(credential.kind, 'oauth2');
    assert.equal(credential.oauth.authorizationServerUrl, 'https://auth.example.com/');
    assert.equal(credential.oauth.clientSecretConfigured, true);
    assert.equal(credential.oauth.tokenStatus, 'missing');
    assert.equal('secret' in credential, false);

    store.updateOAuthCredential(credential.credentialRef, {
      tokens: { access_token: 'access-secret', refresh_token: 'refresh-secret', expires_at: 4102444800000 },
      clientInformation: { client_id: 'client-id', client_secret: 'registered-secret' },
      codeVerifier: 'pkce-secret',
    });

    const metadata = store.getCredential(credential.credentialRef);
    assert.equal(metadata.oauth.tokenStatus, 'available');
    assert.equal(metadata.oauth.expiresAt, new Date(4102444800000).toISOString());
    assert.equal(JSON.stringify(metadata).includes('access-secret'), false);
    assert.equal(JSON.stringify(metadata).includes('refresh-secret'), false);

    const persisted = readFileSync(path.join(tmpDir, 'mcp-credentials.json'), 'utf8');
    assert.equal(persisted.includes('access-secret'), false);
    assert.equal(persisted.includes('refresh-secret'), false);
    assert.equal(persisted.includes('registered-secret'), false);

    const oauthCredential = store.getOAuthCredential(credential.credentialRef);
    assert.equal(oauthCredential.oauth.tokens.access_token, 'access-secret');
    assert.equal(oauthCredential.oauth.clientInformation.client_secret, 'registered-secret');
  });

  it('injects OAuth authProvider config without headers or env', async () => {
    const store = createStore();
    const credential = store.putCredential({
      label: 'OAuth MCP',
      kind: 'oauth2',
      oauth: {
        authorizationServerUrl: 'https://auth.example.com',
        clientId: 'client-id',
        scopes: ['mcp.read'],
      },
    });

    const injection = await resolveMcpCredentialInjection(store, {
      mode: 'oauth2',
      credentialRef: credential.credentialRef,
    }, { transport: 'streamable_http' });

    assert.deepEqual(injection.headers, {});
    assert.deepEqual(injection.env, {});
    assert.equal(injection.authContext.mode, 'oauth2');
    assert.equal(injection.authContext.hasCredential, true);
    assert.equal(injection.authProviderConfig.credentialRef, credential.credentialRef);
    assert.equal(injection.authProviderConfig.oauth.clientId, 'client-id');
    assert.equal(typeof injection.authProviderConfig.updateOAuth, 'function');
  });
});

function legacy(entries) {
  const file = path.join(tmpDir, 'mcp-credentials.json');
  const base = { id:'old', credentialRef:'mcp-cred:old', kind:'http_bearer', label:'old', createdAt:'2026-01-01',updatedAt:'2026-01-02',future:{keep:true} };
  const data = {version:1,future:{keep:true},credentials:entries ?? [{...base,secret:{encrypted:true,scheme:'electron.safeStorage',data:fakeSafeStorage.encryptString('old-secret').toString('base64')}}]};
  writeFileSync(file,JSON.stringify(data));
  return {file,base,before:readFileSync(file)};
}
describe('MCP Vault migration and recovery', () => {
  it('migrates legacy ciphertext and plaintext once, preserves identities and unknown fields', () => {
    const {file,base} = legacy();
    const data = JSON.parse(readFileSync(file));
    data.credentials.push({...base,id:'plain',credentialRef:'mcp-cred:plain',secret:{encrypted:false,scheme:'plaintext-fallback',data:'old-plain'}});
    writeFileSync(file,JSON.stringify(data));
    const store = createStore();
    assert.equal(store.listCredentials().length,2);
    assert.equal(store.resolveSecret('old').secret,'old-secret');
    assert.equal(store.resolveSecret('plain').secret,'old-plain');
    const migrated = JSON.parse(readFileSync(file));
    assert.equal(migrated.version,2);
    assert.deepEqual(migrated.future,{keep:true});
    assert.deepEqual(migrated.credentials[0].future,{keep:true});
    assert.equal(migrated.credentials[0].createdAt,base.createdAt);
    assert.equal(readFileSync(file,'utf8').includes('old-secret'),false);
    const keys = [...secrets.keys()];
    createStore().listCredentials();
    assert.deepEqual([...secrets.keys()],keys);
  });
  it('moves every OAuth sensitive field to Vault and preserves the Desktop SDK view', () => {
    const {file,base} = legacy([]);
    const oauth = {clientId:'client',clientSecret:'client-secret',codeVerifier:'pkce-secret',tokens:{encrypted:false,scheme:'plaintext-fallback',data:JSON.stringify({access_token:'access-secret',refresh_token:'refresh-secret'})},clientInformation:{encrypted:true,scheme:'electron.safeStorage',data:fakeSafeStorage.encryptString(JSON.stringify({client_id:'client',client_secret:'registered-secret'})).toString('base64')},discoveryState:{future:'discovery-secret'}};
    writeFileSync(file,JSON.stringify({version:1,credentials:[{...base,kind:'oauth2',oauth}]}));
    const store = createStore();
    const resolved = store.getOAuthCredential('old');
    for(const secret of ['client-secret','pkce-secret','access-secret','refresh-secret','registered-secret','discovery-secret']) {
      assert.equal(readFileSync(file,'utf8').includes(secret),false);
      assert.equal(JSON.stringify(resolved.metadata).includes(secret),false);
      assert.equal(JSON.stringify(resolved.oauth).includes(secret),true);
    }
  });
  it('preserves original legacy bytes after Helper failure or readback mismatch and allows a later recovery', () => {
    for(const mode of ['set','verify']) {
      const {file,before} = legacy();
      const store = createMcpCredentialStore({credentialFile:file,safeStorage:fakeSafeStorage,credentialClient:{setSecret(){if(mode==='set')throw new Error('unavailable');},getSecret(){return 'mismatch';}}});
      assert.throws(()=>store.listCredentials());
      assert.deepEqual(readFileSync(file),before);
      assert.equal(createStore().resolveSecret('old').secret,'old-secret');
      assert.equal(JSON.parse(readFileSync(file)).version,2);
    }
  });
  it('keeps an earlier item intact when a later migration item cannot be decrypted', () => {
    const {file,base} = legacy();
    const data = JSON.parse(readFileSync(file));
    data.credentials.push({...base,id:'bad',credentialRef:'mcp-cred:bad',secret:{encrypted:true,scheme:'unsupported',data:'invalid'}});
    writeFileSync(file,JSON.stringify(data));
    const before = readFileSync(file);
    assert.throws(()=>createStore().listCredentials());
    assert.deepEqual(readFileSync(file),before);
  });
  it('never falls back to plaintext when the Helper is unavailable on a new write', () => {
    const file = path.join(tmpDir,'mcp-credentials.json');
    const store = createMcpCredentialStore({credentialFile:file,safeStorage:null,credentialClient:{setSecret(){throw new Error('secure_storage_unavailable');}}});
    assert.throws(()=>store.putCredential({kind:'http_bearer',secret:'never-on-disk'}),/secure_storage_unavailable/);
    assert.throws(()=>readFileSync(file),{code:'ENOENT'});
  });
  it('retains the current generation after rotation failure, then publishes a new immutable generation', () => {
    const store = createStore();
    const item = store.putCredential({kind:'http_bearer',secret:'before'});
    const file = path.join(tmpDir,'mcp-credentials.json');
    const before = readFileSync(file);
    const old = JSON.parse(before).credentials[0].vaultKey;
    const bad = createMcpCredentialStore({credentialFile:file,credentialClient:{getSecret:key=>secrets.get(key),setSecret(){throw new Error('failed');}}});
    assert.throws(()=>bad.putCredential({credentialRef:item.credentialRef,secret:'after'}));
    assert.deepEqual(readFileSync(file),before);
    store.putCredential({credentialRef:item.credentialRef,secret:'after'});
    assert.equal(store.resolveSecret(item.credentialRef).secret,'after');
    assert.notEqual(JSON.parse(readFileSync(file)).credentials[0].vaultKey,old);
    assert.ok(secrets.has(old));
  });
  it('rejects source replacement during Vault staging without overwriting the concurrent source', () => {
    const {file} = legacy();
    const concurrent = JSON.stringify({version:2,credentials:[],future:'concurrent'});
    const store = createMcpCredentialStore({credentialFile:file,safeStorage:fakeSafeStorage,credentialClient:{setSecret(key,value){secrets.set(key,value);writeFileSync(file,concurrent);},getSecret:key=>secrets.get(key)}});
    assert.throws(()=>store.listCredentials(),/mcp_credential_changed/);
    assert.equal(readFileSync(file,'utf8'),concurrent);
  });
  it('preserves corrupt or future files, duplicate references, symlinks and live locks', () => {
    const file = path.join(tmpDir,'mcp-credentials.json');
    for(const raw of ['{broken',JSON.stringify({version:3,credentials:[]}),JSON.stringify({version:1,credentials:[{id:'same',credentialRef:'mcp-cred:same',kind:'http_bearer'},{id:'same',credentialRef:'mcp-cred:same',kind:'http_bearer'}]})]) {
      writeFileSync(file,raw);
      assert.throws(()=>createStore().listCredentials());
      assert.equal(readFileSync(file,'utf8'),raw);
    }
    rmSync(file);const target = path.join(tmpDir,'target');writeFileSync(target,'{}');symlinkSync(target,file);
    assert.throws(()=>createStore().listCredentials());
    assert.equal(readFileSync(target,'utf8'),'{}');
    rmSync(file);mkdirSync(`${file}.lock`);
    assert.throws(()=>createStore().putCredential({kind:'http_bearer',secret:'never'}),/lock_busy/);
    assert.equal(readFileSync(target,'utf8'),'{}');
  });
  it('advances one OAuth session across SDK callbacks and rejects late callbacks after rotation', async () => {
    const store=createStore();const item=store.putCredential({kind:'oauth2',oauth:{clientId:'before'}});
    const injection=await resolveMcpCredentialInjection(store,{mode:'oauth2',credentialRef:item.credentialRef},{transport:'streamable_http'});
    injection.authProviderConfig.updateOAuth({codeVerifier:'first-pkce'});
    injection.authProviderConfig.updateOAuth({tokens:{access_token:'first-access'}});
    assert.equal(store.getOAuthCredential(item.credentialRef).oauth.tokens.access_token,'first-access');
    store.putCredential({credentialRef:item.credentialRef,kind:'oauth2',oauth:{clientId:'after',tokens:{access_token:'new-principal'}}});
    const file=path.join(tmpDir,'mcp-credentials.json');const before=readFileSync(file);
    assert.throws(()=>injection.authProviderConfig.updateOAuth({tokens:{access_token:'late-old-access'}}),/mcp_credential_changed/);
    assert.deepEqual(readFileSync(file),before);
    assert.equal(store.getOAuthCredential(item.credentialRef).oauth.tokens.access_token,'new-principal');
  });
});
