import electron from 'electron';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathOf } from './data-store.mjs';
import { createDesktopCredentialClient } from './model-credential-client.mjs';

const CREDENTIAL_PREFIX = 'mcp-cred:';
const SUPPORTED_KINDS = new Set(['http_bearer', 'http_header', 'stdio_env', 'oauth2']);
const MAX_FILE = 1024 * 1024;
const MAX_ENVELOPE = 256 * 1024;
const asString = (v) => typeof v === 'string' ? v.trim() : '';
const nowIso = () => new Date().toISOString();
function normalizeRef(v) {
  const raw = asString(v);
  if (!raw) return '';
  return raw.startsWith(CREDENTIAL_PREFIX) ? raw : `${CREDENTIAL_PREFIX}${raw}`;
}
const idFromRef = (v) => normalizeRef(v).slice(CREDENTIAL_PREFIX.length);
function validateHeaderName(v) {
  const name = asString(v);
  if (name && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new Error('Invalid MCP credential header name.');
  return name;
}
function validateEnvName(v) {
  const name = asString(v);
  if (name && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('Invalid MCP credential env name.');
  return name;
}
function normalizeKind(v) {
  if (!SUPPORTED_KINDS.has(v)) throw new Error('mcp_credential_kind_invalid');
  return v;
}
const targetForKind = (kind) => kind === 'stdio_env' ? 'env' : kind === 'oauth2' ? 'oauth' : 'header';
const normalizeScopes = (v) => Array.isArray(v) ? v.map(asString).filter(Boolean) : asString(v).split(/[\s,]+/).filter(Boolean);
function normalizeUrl(v) {
  if (!asString(v)) return '';
  let u;
  try { u = new URL(v); } catch { throw new Error('Invalid MCP OAuth URL.'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('Invalid MCP OAuth URL.');
  return u.toString();
}
function normalizeOAuth(input = {}, existing = {}) {
  const next = { ...existing, ...input };
  for (const key of ['authorizationServerUrl', 'redirectUrl']) next[key] = normalizeUrl(next[key]);
  next.scopes = normalizeScopes(next.scopes);
  next.clientId = asString(next.clientId);
  next.clientSecret = String(next.clientSecret ?? '');
  next.codeVerifier = asString(next.codeVerifier);
  return next;
}
function oauthView(oauth = {}) {
  const expires = Number(oauth.tokens?.expires_at ?? oauth.tokens?.expiresAt ?? 0);
  return {
    authorizationServerUrl: asString(oauth.authorizationServerUrl) || undefined,
    clientId: asString(oauth.clientId) || undefined,
    clientSecretConfigured: Boolean(oauth.clientSecret),
    scopes: normalizeScopes(oauth.scopes),
    redirectUrl: asString(oauth.redirectUrl) || undefined,
    tokenStatus: oauth.tokens?.access_token ? 'available' : 'missing',
    expiresAt: expires > 0 && Number.isFinite(expires) ? new Date(expires).toISOString() : undefined,
  };
}
const refHash = (ref) => createHash('sha256').update(ref).digest('hex');
function bounded(value, maxNodes = 65536) {
  const pending = [[value, 0]];
  let nodes = 0;
  while (pending.length) {
    const [item, depth] = pending.pop();
    if (++nodes > maxNodes || depth > 32) throw new Error('mcp_credential_limit');
    if (item && typeof item === 'object') {
      for (const child of Object.values(item)) {
        if (nodes + pending.length >= maxNodes) throw new Error('mcp_credential_limit');
        pending.push([child, depth + 1]);
      }
    }
  }
}
const keyPattern = /^mcp\/[a-f0-9]{64}\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function validEntry(entry, version) {
  if (!entry || typeof entry !== 'object' || !asString(entry.id) || entry.credentialRef !== normalizeRef(entry.id)
    || entry.id !== idFromRef(entry.credentialRef) || entry.credentialRef.length > 1024) throw new Error('mcp_credential_invalid');
  normalizeKind(entry.kind);
  if(version===2 && entry.kind==='oauth2' && (!entry.oauth || typeof entry.oauth!=='object' || Array.isArray(entry.oauth))) throw new Error('mcp_credential_invalid');
  if (version === 2 && (!keyPattern.test(entry.vaultKey) || !entry.vaultKey.startsWith(`mcp/${refHash(entry.credentialRef)}/`)
    || 'secret' in entry || (entry.oauth && Object.keys(entry.oauth).some(k => !['authorizationServerUrl','clientId','clientSecretConfigured','scopes','redirectUrl','tokenStatus','expiresAt'].includes(k))))) throw new Error('mcp_credential_invalid');
}
function validFile(data) {
  bounded(data);
  if (![1,2].includes(data.version) || !Array.isArray(data.credentials) || data.credentials.length > 1024) throw new Error('mcp_credential_version_unsupported');
  const refs = new Set();
  for (const entry of data.credentials) {
    validEntry(entry, data.version);
    if (refs.has(entry.credentialRef)) throw new Error('mcp_credential_invalid');
    refs.add(entry.credentialRef);
  }
}
function metadata(entry) {
  const { id, credentialRef, label, kind, target, headerName, envName, oauth, createdAt, updatedAt, lastFour } = entry;
  return { id, credentialRef, label, kind, target, headerName, envName, oauth, createdAt, updatedAt, lastFour, storage: 'vault' };
}
function identity(file) {
  try {
    const stat = lstatSync(file, { bigint: true });
    if (!stat.isFile() || stat.size > BigInt(MAX_FILE)) throw new Error('mcp_credential_invalid');
    return statIdentity(stat);
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
const statIdentity = (stat) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
function load(file) {
  const before = identity(file);
  let raw = null;
  if(before !== null) {
    const fd=openSync(file,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const stat=fstatSync(fd,{bigint:true});
      if(!stat.isFile() || statIdentity(stat)!==before) throw new Error('mcp_credential_changed');
      raw=readFileSync(fd);
    } finally { closeSync(fd); }
  }
  if (identity(file) !== before || (raw && raw.length > MAX_FILE)) throw new Error('mcp_credential_changed');
  let data;
  try { data = raw ? JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)) : { version: 2, credentials: [] }; }
  catch { throw new Error('mcp_credential_invalid'); }
  validFile(data);
  return { data, raw, before };
}
function publish(file, source, data, checkLock) {
  validFile(data);
  const bytes = Buffer.from(`${JSON.stringify(data, null, 2)}\n`);
  if (bytes.length > MAX_FILE) throw new Error('mcp_credential_limit');
  const temporary = `${file}.${randomUUID()}.tmp`;
  let renamed = false;
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    checkLock();
    if (identity(file) !== source.before || (source.raw && !readFileSync(file).equals(source.raw))) throw new Error('mcp_credential_changed');
    renameSync(temporary, file); renamed = true;
    const dir = openSync(dirname(file), 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } catch (error) {
    if (renamed) throw new Error('mcp_credential_commit_uncertain');
    throw error;
  } finally { if (!renamed && existsSync(temporary)) unlinkSync(temporary); }
}
function unseal(stored, safeStorage) {
  if (!stored || typeof stored !== 'object') throw new Error('mcp_credential_legacy_invalid');
  if (stored.encrypted === false && stored.scheme === 'plaintext-fallback' && typeof stored.data === 'string') return stored.data;
  if (stored.encrypted !== true || stored.scheme !== 'electron.safeStorage' || !safeStorage?.isEncryptionAvailable?.()) throw new Error('mcp_credential_migration_required');
  try { return safeStorage.decryptString(Buffer.from(stored.data, 'base64')); }
  catch { throw new Error('mcp_credential_migration_failed'); }
}
function unsealJson(stored, safeStorage) {
  if (stored == null) return stored;
  if (stored && typeof stored === 'object' && 'encrypted' in stored) {
    try { return JSON.parse(unseal(stored, safeStorage)); } catch { throw new Error('mcp_credential_migration_failed'); }
  }
  return stored;
}

export function createMcpCredentialStore({ credentialFile = pathOf('mcpCredentials'), safeStorage = electron?.safeStorage, credentialClient } = {}) {
  let client = credentialClient;
  const helper = () => client ??= createDesktopCredentialClient({ dataHome: dirname(credentialFile) });
  function envelope(entry) {
    const raw = helper().getSecret(entry.vaultKey);
    if (!raw || Buffer.byteLength(raw) > MAX_ENVELOPE) throw new Error('mcp_credential_missing');
    let payload;
    try { payload = JSON.parse(raw); } catch { throw new Error('mcp_credential_invalid'); }
    bounded(payload, 8192);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.version !== 1 || payload.credentialRef !== entry.credentialRef || payload.kind !== entry.kind) throw new Error('mcp_credential_invalid');
    const current=load(credentialFile).data.credentials.find(item=>item.credentialRef===entry.credentialRef);
    if(current?.vaultKey!==entry.vaultKey) throw new Error('mcp_credential_changed');
    return payload;
  }
  function stage(entry, payload) {
    if(entry.kind!=='oauth2' && (typeof payload.secret!=='string' || !payload.secret)) throw new Error('mcp_credential_invalid');
    bounded(payload, 8192);
    const raw = JSON.stringify({ ...payload, version: 1, credentialRef: entry.credentialRef, kind: entry.kind });
    if (Buffer.byteLength(raw) > MAX_ENVELOPE) throw new Error('mcp_credential_limit');
    const vaultKey = `mcp/${refHash(entry.credentialRef)}/${randomUUID()}`;
    helper().setSecret(vaultKey, raw);
    const actual = helper().getSecret(vaultKey);
    const expectedBytes = Buffer.from(raw);
    const actualBytes = Buffer.from(actual ?? '');
    if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) throw new Error('mcp_credential_verification_failed');
    const next = { ...entry, vaultKey, storage: 'vault' };
    delete next.secret;
    if (entry.kind === 'oauth2') {
      next.oauth = oauthView(payload.oauth);
      if ('refreshState' in payload) next.oauth.tokenStatus = 'recovery_required';
    }
    else delete next.oauth;
    return next;
  }
  function openTransaction() {
    mkdirSync(dirname(credentialFile), { recursive: true, mode: 0o700 });
    const lock = `${credentialFile}.lock`;
    try { mkdirSync(lock, { mode: 0o700 }); } catch { throw new Error('mcp_credential_lock_busy'); }
    const owner = lstatSync(lock, { bigint: true });
    const checkLock = () => {
      const current = lstatSync(lock, { bigint: true });
      if (!current.isDirectory() || current.dev !== owner.dev || current.ino !== owner.ino) throw new Error('mcp_credential_lock_changed');
    };
    try {
      let source = load(credentialFile);
      const data = { ...source.data, credentials: [...source.data.credentials] };
      if (data.version === 1) {
        data.credentials = data.credentials.map(entry => {
          let payload;
          if (entry.kind === 'oauth2') {
            const oauth = { ...entry.oauth };
            oauth.tokens = unsealJson(oauth.tokens, safeStorage);
            oauth.clientInformation = unsealJson(oauth.clientInformation, safeStorage);
            payload = { oauth };
          } else payload = { secret: unseal(entry.secret, safeStorage) };
          return stage(entry, payload);
        });
        data.version = 2;
      }
      return { data, publish() {
        publish(credentialFile, source, data, checkLock);
        checkLock();
        const actual = load(credentialFile);
        if (!actual.raw?.equals(Buffer.from(`${JSON.stringify(data, null, 2)}\n`))) throw new Error('mcp_credential_commit_uncertain');
        source = actual;
      }, close() { checkLock(); rmdirSync(lock); } };
    } catch (error) { checkLock(); rmdirSync(lock); throw error; }
  }
  function transaction(action) {
    const tx = openTransaction();
    try { const result = action(tx.data); tx.publish(); return result; }
    finally { tx.close(); }
  }
  function readAll() {
    const source = load(credentialFile);
    if (source.data.version === 1) return transaction(data => data.credentials);
    return source.data.credentials;
  }
  function find(ref) { return readAll().find(entry => entry.credentialRef === normalizeRef(ref)) ?? null; }
  function writeCredential(input = {}, expectedRevision) {
    return transaction(data => {
      const id = idFromRef(input.credentialRef ?? input.id ?? randomUUID());
      const credentialRef = normalizeRef(id);
      const index = data.credentials.findIndex(entry => entry.credentialRef === credentialRef);
      const old = index < 0 ? null : data.credentials[index];
      if(expectedRevision !== undefined && old?.vaultKey !== expectedRevision) throw new Error('mcp_credential_changed');
      const kind = normalizeKind(input.kind ?? old?.kind);
      if (old && kind !== old.kind) throw new Error('mcp_credential_kind_invalid');
      const previous = old ? envelope(old) : {};
      if ('refreshState' in previous) throw new Error('mcp_oauth_recovery_required');
      const payload = kind === 'oauth2' ? { ...previous, oauth: normalizeOAuth(input.oauth, previous.oauth) } : { ...previous, secret: input.secret ?? previous.secret };
      if (kind !== 'oauth2' && (typeof payload.secret !== 'string' || !payload.secret.length)) throw new Error('MCP credential secret is required.');
      const entry = {
        ...old, id, credentialRef, kind, target: targetForKind(kind), label: asString(input.label) || old?.label || 'MCP credential',
        createdAt: old?.createdAt ?? nowIso(), updatedAt: nowIso(),
        headerName: kind === 'http_header' ? validateHeaderName(input.headerName ?? old?.headerName) : undefined,
        envName: kind === 'stdio_env' ? validateEnvName(input.envName ?? old?.envName) : undefined,
        lastFour: kind === 'oauth2' ? '' : payload.secret.slice(-4),
      };
      if (kind === 'http_header' && !entry.headerName) throw new Error('MCP HTTP header credential requires headerName.');
      if (kind === 'stdio_env' && !entry.envName) throw new Error('MCP stdio env credential requires envName.');
      const next = stage(entry, payload);
      validEntry(next, 2);
      if (index < 0) data.credentials.push(next); else data.credentials[index] = next;
      return { metadata:metadata(next), revision:next.vaultKey };
    });
  }
  return {
    listCredentials: () => readAll().map(metadata),
    getCredential: (ref) => { const entry = find(ref); return entry ? metadata(entry) : null; },
    putCredential: (input) => writeCredential(input).metadata,
    deleteCredential(ref) {
      const credentialRef = normalizeRef(ref?.credentialRef ?? ref);
      return transaction(data => {
        const before = data.credentials.length;
        data.credentials = data.credentials.filter(entry => entry.credentialRef !== credentialRef);
        return { credentialRef, deleted: before !== data.credentials.length };
      });
    },
    resolveSecret(ref) {
      const entry = find(ref);
      if (!entry) throw new Error('MCP credential not found.');
      const payload = envelope(entry);
      if (typeof payload.secret !== 'string' || !payload.secret) throw new Error('mcp_credential_invalid');
      return { metadata: metadata(entry), secret: payload.secret };
    },
    getOAuthCredential(ref, { purpose = 'runtime' } = {}) {
      const entry = find(ref);
      if (!entry) throw new Error('MCP credential not found.');
      if (entry.kind !== 'oauth2') throw new Error('MCP credential is not OAuth 2.0.');
      const payload = envelope(entry);
      const authorize = purpose === 'authorize';
      const knownPending = (state) => state?.schemaVersion === 1
        && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(state.operationId)
        && state.previousTokens && typeof state.previousTokens === 'object' && !Array.isArray(state.previousTokens);
      const checkPending = (value) => {
        if ('refreshState' in value && (!authorize || !knownPending(value.refreshState))) throw new Error('mcp_oauth_recovery_required');
      };
      checkPending(payload);
      const oauth = { ...payload.oauth };
      if ('refreshState' in payload) delete oauth.tokens;
      const originalIssuers = [oauth.nativeIssuer,oauth.authorizationServerUrl,oauth.discoveryState?.authorizationServerUrl,oauth.discoveryState?.authorizationServerMetadata?.issuer].filter(v => v !== undefined && v !== '');
      const originalClient = oauth.clientInformation?.client_id ?? oauth.clientId;
      let revision = entry.vaultKey;
      const assertCurrent = () => {
        const data = load(credentialFile).data;
        const current = data.credentials.find(item => item.credentialRef === entry.credentialRef);
        if (data.version !== 2 || current?.kind !== 'oauth2' || current.vaultKey !== revision) throw new Error('mcp_credential_changed');
      };
      const adopt = (next, value) => {
        revision = next.vaultKey;
        for (const key of Object.keys(oauth)) delete oauth[key];
        Object.assign(oauth, value.oauth);
        if ('refreshState' in value) delete oauth.tokens;
      };
      const currentIn = (tx) => {
        const index = tx.data.credentials.findIndex(item => item.credentialRef === entry.credentialRef);
        const current = tx.data.credentials[index];
        if (current?.kind !== 'oauth2' || current.vaultKey !== revision) throw new Error('mcp_credential_changed');
        return { index, current, value: envelope(current) };
      };
      return { metadata: metadata(entry), oauth, assertCurrent,
        updateOAuth(patch) {
          const tx = openTransaction();
          try {
            const { index, current, value } = currentIn(tx);
            checkPending(value);
            if ('refreshState' in value && Object.keys(patch).some(key => !['discoveryState','clientInformation','codeVerifier'].includes(key))) throw new Error('mcp_oauth_recovery_required');
            const updated = { ...value, oauth: normalizeOAuth(patch, value.oauth) };
            const next = stage(current, updated);
            tx.data.credentials[index] = next;
            tx.publish();
            adopt(next, updated);
            return metadata(next);
          } finally { tx.close(); }
        },
        async exchangeTokens(request, exchange) {
          const tx = openTransaction();
          try {
            const { index, current, value } = currentIn(tx);
            checkPending(value);
            const old = value.oauth;
            const tokenUrl = (url) => {
              let parsed;
              try { parsed = new URL(url); } catch { throw new Error('mcp_oauth_binding_invalid'); }
              if (!['https:','http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) throw new Error('mcp_oauth_binding_invalid');
              return parsed.href;
            };
            const cache = old.discoveryState;
            const issuers = [...originalIssuers,old.nativeIssuer,old.authorizationServerUrl,cache?.authorizationServerUrl,cache?.authorizationServerMetadata?.issuer].filter(v => v !== undefined && v !== '');
            const pinned = issuers.map(tokenUrl);
            if (!pinned.length || pinned.some(v => v !== pinned[0])
              || tokenUrl(request.tokenUrl) !== tokenUrl(cache?.authorizationServerMetadata?.token_endpoint)) throw new Error('mcp_oauth_binding_invalid');
            const refresh = request.grantType === 'refresh_token';
            if (!refresh && (request.grantType !== 'authorization_code' || !authorize)) throw new Error('mcp_oauth_exchange_forbidden');
            if (refresh && ((old.clientInformation?.client_id ?? old.clientId) !== originalClient || 'refreshState' in value || !old.tokens?.refresh_token || request.refreshToken !== old.tokens.refresh_token)) throw new Error('mcp_oauth_binding_changed');
            if (!refresh && (!old.codeVerifier || request.codeVerifier !== old.codeVerifier)) throw new Error('mcp_oauth_binding_changed');
            const previousTokens = value.refreshState?.previousTokens ?? old.tokens ?? {};
            if (refresh && 'scope' in previousTokens && typeof previousTokens.scope !== 'string') throw new Error('mcp_oauth_scope_invalid');
            const pending = { ...value, oauth: { ...old }, refreshState: { schemaVersion:1, operationId:randomUUID(), previousTokens } };
            delete pending.oauth.tokens;
            const intent = stage(current, pending);
            tx.data.credentials[index] = intent;
            tx.publish();
            // The lock remains owned across the one remote exchange. No old token is republished on any failure.
            const tokens = { ...await exchange() };
            const scopes = (v) => [...new Set(String(v ?? '').split(/\s+/).filter(Boolean))].sort().join(' ');
            if (refresh) {
              if (!tokens.refresh_token) tokens.refresh_token = previousTokens.refresh_token;
              const oldScope = typeof previousTokens.scope === 'string' ? previousTokens.scope : normalizeScopes(old.scopes).join(' ');
              if (tokens.scope !== undefined && scopes(tokens.scope) !== scopes(oldScope)) throw new Error('mcp_oauth_scope_changed');
              if (tokens.scope === undefined && oldScope) tokens.scope = oldScope;
            }
            if (tokens.expires_in !== undefined) {
              const expires = Number(tokens.expires_in), at = Date.now() + expires * 1000;
              if (!Number.isFinite(expires) || expires <= 0 || !Number.isSafeInteger(at) || at > 8640000000000000) throw new Error('mcp_oauth_expiry_invalid');
              tokens.expires_at = at;
            }
            const updated = { ...value, oauth: { ...old, nativeIssuer:pinned[0], codeVerifier:'', tokens } };
            delete updated.refreshState;
            const next = stage(intent, updated);
            tx.data.credentials[index] = next;
            tx.publish();
            adopt(next, updated);
            return tokens;
          } finally { tx.close(); }
        },
      };
    },
    updateOAuthCredential(ref, patch = {}) {
      return writeCredential({ credentialRef: ref, kind: 'oauth2', oauth: patch }).metadata;
    },
  };
}

function normalizeAuthBinding(auth = {}) {
  const mode = asString(auth?.mode) || 'none';
  if (mode === 'none') return { mode: 'none' };
  if (!SUPPORTED_KINDS.has(mode)) throw new Error(`Unsupported MCP auth mode: ${mode}`);
  const credentialRef = normalizeRef(auth.credentialRef);
  if (!credentialRef) throw new Error(`MCP auth mode ${mode} requires credentialRef.`);
  const binding = { mode, credentialRef };
  if (mode === 'http_header') binding.headerName = validateHeaderName(auth.headerName);
  if (mode === 'stdio_env') binding.envName = validateEnvName(auth.envName);
  return binding;
}

function ensureCompatible(kind, auth, server) {
  if (kind !== auth.mode) throw new Error(`MCP credential kind ${kind} is incompatible with auth mode ${auth.mode}.`);
  const transport = server?.transport === 'stdio' ? 'stdio' : server?.transport === 'sse' ? 'sse' : 'streamable_http';
  if ((kind === 'http_bearer' || kind === 'http_header' || kind === 'oauth2') && transport === 'stdio') {
    throw new Error(`MCP auth mode ${kind} requires an HTTP MCP transport.`);
  }
  if (kind === 'stdio_env' && transport !== 'stdio') {
    throw new Error('MCP auth mode stdio_env requires a stdio MCP transport.');
  }
}

export async function resolveMcpCredentialInjection(credentialStore, auth = {}, server = {}, context = {}) {
  const binding = normalizeAuthBinding(auth);
  if (binding.mode === 'none') {
    return { headers: {}, env: {}, authContext: { mode: 'none', hasCredential: false } };
  }
  if (!credentialStore || typeof credentialStore.resolveSecret !== 'function') {
    throw new Error('MCP credential resolver is not configured.');
  }

  if (binding.mode === 'oauth2') {
    if (typeof credentialStore.getOAuthCredential !== 'function') throw new Error('MCP OAuth credential resolver is not configured.');
    const { metadata, oauth, updateOAuth, assertCurrent, exchangeTokens } = credentialStore.getOAuthCredential(binding.credentialRef, context);
    if(typeof updateOAuth!=='function') throw new Error('mcp_oauth_revision_guard_required');
    ensureCompatible(metadata.kind, binding, server);
    return {
      headers: {},
      env: {},
      authProviderConfig: {
        credentialRef: metadata.credentialRef,
        oauth,
        updateOAuth,
        assertCurrent,
        exchangeTokens,
      },
      authContext: {
        mode: binding.mode,
        credentialRef: metadata.credentialRef,
        credentialUpdatedAt: metadata.updatedAt,
        hasCredential: true,
        oauth: metadata.oauth,
      },
    };
  }

  const { metadata, secret } = credentialStore.resolveSecret(binding.credentialRef);
  ensureCompatible(metadata.kind, binding, server);

  if (binding.mode === 'http_bearer') {
    return {
      headers: { Authorization: `Bearer ${secret}` },
      env: {},
      authContext: {
        mode: binding.mode,
        credentialRef: metadata.credentialRef,
        credentialUpdatedAt: metadata.updatedAt,
        hasCredential: true,
      },
    };
  }

  if (binding.mode === 'http_header') {
    const headerName = validateHeaderName(binding.headerName || metadata.headerName);
    return {
      headers: { [headerName]: secret },
      env: {},
      authContext: {
        mode: binding.mode,
        credentialRef: metadata.credentialRef,
        credentialUpdatedAt: metadata.updatedAt,
        headerName,
        hasCredential: true,
      },
    };
  }

  const envName = validateEnvName(binding.envName || metadata.envName);
  return {
    headers: {},
    env: { [envName]: secret },
    authContext: {
      mode: binding.mode,
      credentialRef: metadata.credentialRef,
      credentialUpdatedAt: metadata.updatedAt,
      envName,
      hasCredential: true,
    },
  };
}

export function createMcpCredentialResolver(credentialStore) {
  return (auth, server, context) => resolveMcpCredentialInjection(credentialStore, auth, server, context);
}

export const MCP_CREDENTIAL_PREFIX = CREDENTIAL_PREFIX;
