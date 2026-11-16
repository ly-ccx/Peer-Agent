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
    if (payload.version !== 1 || payload.credentialRef !== entry.credentialRef || payload.kind !== entry.kind) throw new Error('mcp_credential_invalid');
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
    if (entry.kind === 'oauth2') next.oauth = oauthView(payload.oauth);
    else delete next.oauth;
    return next;
  }
  function transaction(action) {
    mkdirSync(dirname(credentialFile), { recursive: true, mode: 0o700 });
    const lock = `${credentialFile}.lock`;
    try { mkdirSync(lock, { mode: 0o700 }); } catch { throw new Error('mcp_credential_lock_busy'); }
    const owner = lstatSync(lock, { bigint: true });
    const checkLock = () => {
      const current = lstatSync(lock, { bigint: true });
      if (!current.isDirectory() || current.dev !== owner.dev || current.ino !== owner.ino) throw new Error('mcp_credential_lock_changed');
    };
    try {
      const source = load(credentialFile);
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
      const result = action(data);
      publish(credentialFile, source, data, checkLock);
      return result;
    } finally { checkLock(); rmdirSync(lock); }
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
      const payload = kind === 'oauth2' ? { oauth: normalizeOAuth(input.oauth, previous.oauth) } : { secret: input.secret ?? previous.secret };
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
    getOAuthCredential(ref) {
      const entry = find(ref);
      if (!entry) throw new Error('MCP credential not found.');
      if (entry.kind !== 'oauth2') throw new Error('MCP credential is not OAuth 2.0.');
      const payload = envelope(entry);
      if ('refreshState' in payload) throw new Error('mcp_oauth_recovery_required');
      let revision=entry.vaultKey;
      return { metadata: metadata(entry), oauth: payload.oauth, updateOAuth(patch) {
        const result=writeCredential({credentialRef:entry.credentialRef,kind:'oauth2',oauth:patch},revision);
        revision=result.revision;
        return result.metadata;
      } };
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

export async function resolveMcpCredentialInjection(credentialStore, auth = {}, server = {}) {
  const binding = normalizeAuthBinding(auth);
  if (binding.mode === 'none') {
    return { headers: {}, env: {}, authContext: { mode: 'none', hasCredential: false } };
  }
  if (!credentialStore || typeof credentialStore.resolveSecret !== 'function') {
    throw new Error('MCP credential resolver is not configured.');
  }

  if (binding.mode === 'oauth2') {
    if (typeof credentialStore.getOAuthCredential !== 'function') throw new Error('MCP OAuth credential resolver is not configured.');
    const { metadata, oauth, updateOAuth } = credentialStore.getOAuthCredential(binding.credentialRef);
    if(typeof updateOAuth!=='function') throw new Error('mcp_oauth_revision_guard_required');
    ensureCompatible(metadata.kind, binding, server);
    return {
      headers: {},
      env: {},
      authProviderConfig: {
        credentialRef: metadata.credentialRef,
        oauth,
        updateOAuth,
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
  return (auth, server) => resolveMcpCredentialInjection(credentialStore, auth, server);
}

export const MCP_CREDENTIAL_PREFIX = CREDENTIAL_PREFIX;
