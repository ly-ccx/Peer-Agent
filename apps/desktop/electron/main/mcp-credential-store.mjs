import electron from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathOf } from './data-store.mjs';

const VERSION = 1;
const CREDENTIAL_PREFIX = 'mcp-cred:';
const SUPPORTED_KINDS = new Set(['http_bearer', 'http_header', 'stdio_env', 'oauth2']);
const SAFE_STORAGE_SCHEME = 'electron.safeStorage';
const PLAINTEXT_FALLBACK_SCHEME = 'plaintext-fallback';

function nowIso() {
  return new Date().toISOString();
}

function asString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeRef(value) {
  const raw = asString(value);
  if (!raw) return '';
  return raw.startsWith(CREDENTIAL_PREFIX) ? raw : `${CREDENTIAL_PREFIX}${raw}`;
}

function idFromRef(value) {
  const ref = normalizeRef(value);
  return ref.startsWith(CREDENTIAL_PREFIX) ? ref.slice(CREDENTIAL_PREFIX.length) : ref;
}

function validateHeaderName(value) {
  const headerName = asString(value);
  if (!headerName) return '';
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(headerName)) {
    throw new Error('Invalid MCP credential header name.');
  }
  return headerName;
}

function validateEnvName(value) {
  const envName = asString(value);
  if (!envName) return '';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
    throw new Error('Invalid MCP credential env name.');
  }
  return envName;
}

function normalizeKind(value) {
  const kind = asString(value);
  if (!SUPPORTED_KINDS.has(kind)) throw new Error(`Unsupported MCP credential kind: ${kind || '(empty)'}`);
  return kind;
}

function targetForKind(kind) {
  if (kind === 'stdio_env') return 'env';
  if (kind === 'oauth2') return 'oauth';
  return 'header';
}

function normalizeScopes(value) {
  if (Array.isArray(value)) return value.map(asString).filter(Boolean);
  return asString(value).split(/[\s,]+/).map((scope) => scope.trim()).filter(Boolean);
}

function normalizeUrl(value) {
  const raw = asString(value);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Unsupported protocol');
    return url.toString();
  } catch {
    throw new Error('Invalid MCP OAuth URL.');
  }
}

function normalizeOAuthConfig(input = {}, existing = {}, safeStorage = null) {
  const authorizationServerUrl = Object.prototype.hasOwnProperty.call(input, 'authorizationServerUrl')
    ? normalizeUrl(input.authorizationServerUrl)
    : asString(existing.authorizationServerUrl);
  const clientId = Object.prototype.hasOwnProperty.call(input, 'clientId') ? asString(input.clientId) : asString(existing.clientId);
  const hasClientSecret = Object.prototype.hasOwnProperty.call(input, 'clientSecret');
  const clientSecret = hasClientSecret ? String(input.clientSecret ?? '') : existing.clientSecret;
  const scopes = Object.prototype.hasOwnProperty.call(input, 'scopes') ? normalizeScopes(input.scopes) : normalizeScopes(existing.scopes);
  const redirectUrl = Object.prototype.hasOwnProperty.call(input, 'redirectUrl')
    ? normalizeUrl(input.redirectUrl)
    : asString(existing.redirectUrl);
  return {
    authorizationServerUrl,
    clientId,
    clientSecret,
    scopes,
    redirectUrl,
    tokens: Object.prototype.hasOwnProperty.call(input, 'tokens') ? secureJson(input.tokens, safeStorage) : existing.tokens ?? null,
    clientInformation: Object.prototype.hasOwnProperty.call(input, 'clientInformation')
      ? secureJson(input.clientInformation, safeStorage)
      : existing.clientInformation ?? null,
    codeVerifier: asString(input.codeVerifier ?? existing.codeVerifier),
    discoveryState: input.discoveryState && typeof input.discoveryState === 'object'
      ? input.discoveryState
      : existing.discoveryState && typeof existing.discoveryState === 'object' ? existing.discoveryState : null,
  };
}

function oauthView(config = {}, safeStorage = null) {
  const tokens = revealJson(config.tokens, safeStorage);
  const tokenExpiresAt = Number(tokens?.expires_at ?? tokens?.expiresAt ?? 0);
  return {
    authorizationServerUrl: asString(config.authorizationServerUrl) || undefined,
    clientId: asString(config.clientId) || undefined,
    clientSecretConfigured: Boolean(config.clientSecret),
    scopes: normalizeScopes(config.scopes),
    redirectUrl: asString(config.redirectUrl) || undefined,
    tokenStatus: tokens?.access_token ? 'available' : 'missing',
    expiresAt: tokenExpiresAt > 0 ? new Date(tokenExpiresAt).toISOString() : undefined,
  };
}

function getSafeStorage(adapter) {
  return adapter ?? electron?.safeStorage ?? null;
}

function canUseSafeStorage(safeStorage) {
  try {
    return Boolean(safeStorage?.isEncryptionAvailable?.());
  } catch {
    return false;
  }
}

function encryptSecret(plaintext, safeStorage) {
  const secret = String(plaintext ?? '');
  if (canUseSafeStorage(safeStorage)) {
    const encrypted = safeStorage.encryptString(secret);
    return {
      encrypted: true,
      scheme: SAFE_STORAGE_SCHEME,
      data: Buffer.from(encrypted).toString('base64'),
    };
  }
  return {
    encrypted: false,
    scheme: PLAINTEXT_FALLBACK_SCHEME,
    data: secret,
  };
}

function decryptSecret(stored, safeStorage) {
  if (!stored || typeof stored !== 'object') return '';
  if (!stored.encrypted) return String(stored.data ?? '');
  if (stored.scheme !== SAFE_STORAGE_SCHEME) throw new Error(`Unsupported MCP credential storage scheme: ${stored.scheme}`);
  if (!canUseSafeStorage(safeStorage)) throw new Error('MCP credential encryption is not available on this device.');
  return safeStorage.decryptString(Buffer.from(String(stored.data ?? ''), 'base64'));
}

function secureJson(value, safeStorage) {
  if (value == null) return null;
  if (typeof value === 'object' && (value.encrypted !== undefined || Object.prototype.hasOwnProperty.call(value, 'data'))) return value;
  return encryptSecret(JSON.stringify(value), safeStorage);
}

function revealJson(stored, safeStorage) {
  if (!stored || typeof stored !== 'object') return undefined;
  if (stored.encrypted !== undefined || Object.prototype.hasOwnProperty.call(stored, 'data')) {
    const raw = decryptSecret(stored, safeStorage);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  return stored;
}

function loadCredentialFile(file) {
  if (!existsSync(file)) return { version: VERSION, credentials: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return {
      version: Number(parsed?.version) || VERSION,
      credentials: Array.isArray(parsed?.credentials) ? parsed.credentials : [],
    };
  } catch {
    return { version: VERSION, credentials: [] };
  }
}

function writeCredentialFile(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ version: VERSION, credentials: data.credentials ?? [] }, null, 2)}\n`, 'utf8');
}

function normalizeStoredCredential(entry, safeStorage = null) {
  const id = asString(entry?.id) || randomUUID();
  const kind = SUPPORTED_KINDS.has(entry?.kind) ? entry.kind : 'http_bearer';
  const createdAt = asString(entry?.createdAt) || nowIso();
  const updatedAt = asString(entry?.updatedAt) || createdAt;
  const oauth = kind === 'oauth2' ? normalizeOAuthConfig(entry?.oauth ?? {}, {}, safeStorage) : undefined;
  return {
    id,
    credentialRef: normalizeRef(entry?.credentialRef ?? id),
    label: asString(entry?.label) || 'MCP credential',
    kind,
    target: targetForKind(kind),
    headerName: kind === 'http_header' ? validateHeaderName(entry?.headerName) : undefined,
    envName: kind === 'stdio_env' ? validateEnvName(entry?.envName) : undefined,
    oauth,
    secret: entry?.secret && typeof entry.secret === 'object' ? entry.secret : encryptSecret('', null),
    lastFour: asString(entry?.lastFour),
    storage: entry?.secret?.scheme === SAFE_STORAGE_SCHEME ? 'safeStorage' : 'file-fallback',
    createdAt,
    updatedAt,
  };
}

function metadataFromStored(entry, safeStorage = null) {
  return {
    id: entry.id,
    credentialRef: entry.credentialRef,
    label: entry.label,
    kind: entry.kind,
    target: entry.target,
    headerName: entry.headerName,
    envName: entry.envName,
    oauth: entry.kind === 'oauth2' ? oauthView(entry.oauth, safeStorage) : undefined,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    lastFour: entry.lastFour,
    storage: entry.storage,
  };
}

function normalizeCredentialInput(input = {}, existing = null, safeStorage = null) {
  const kind = normalizeKind(input.kind ?? existing?.kind);
  const now = nowIso();
  const id = idFromRef(input.credentialRef ?? input.id ?? existing?.credentialRef ?? existing?.id ?? randomUUID());
  const label = asString(input.label) || existing?.label || 'MCP credential';
  const isOAuth = kind === 'oauth2';
  const hasSecret = Object.prototype.hasOwnProperty.call(input, 'secret');
  if (!isOAuth && !hasSecret && !existing) throw new Error('MCP credential secret is required.');
  const secretValue = hasSecret ? String(input.secret ?? '') : null;
  if (!isOAuth && hasSecret && secretValue.length === 0) throw new Error('MCP credential secret is required.');
  const headerName = kind === 'http_header'
    ? validateHeaderName(input.headerName ?? existing?.headerName)
    : undefined;
  const envName = kind === 'stdio_env'
    ? validateEnvName(input.envName ?? existing?.envName)
    : undefined;
  if (kind === 'http_header' && !headerName) throw new Error('MCP HTTP header credential requires headerName.');
  if (kind === 'stdio_env' && !envName) throw new Error('MCP stdio env credential requires envName.');

  const oauth = isOAuth ? normalizeOAuthConfig(input.oauth ?? {}, existing?.oauth ?? {}, safeStorage) : undefined;
  const encryptedSecret = isOAuth ? (existing?.secret ?? encryptSecret('', safeStorage)) : (hasSecret ? encryptSecret(secretValue, safeStorage) : existing.secret);
  return {
    id,
    credentialRef: normalizeRef(id),
    label,
    kind,
    target: targetForKind(kind),
    headerName,
    envName,
    oauth,
    secret: encryptedSecret,
    lastFour: hasSecret ? secretValue.slice(-4) : existing?.lastFour,
    storage: encryptedSecret.scheme === SAFE_STORAGE_SCHEME ? 'safeStorage' : 'file-fallback',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
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

export function createMcpCredentialStore({ credentialFile = pathOf('mcpCredentials'), safeStorage = getSafeStorage() } = {}) {
  function readAll() {
    return loadCredentialFile(credentialFile).credentials.map((entry) => normalizeStoredCredential(entry, safeStorage));
  }

  function writeAll(credentials) {
    writeCredentialFile(credentialFile, { credentials });
  }

  function listCredentials() {
    return readAll().map((entry) => metadataFromStored(entry, safeStorage));
  }

  function putCredential(input = {}) {
    const credentials = readAll();
    const ref = input.credentialRef ?? input.id;
    const id = ref ? idFromRef(ref) : '';
    const index = id ? credentials.findIndex((entry) => entry.id === id || entry.credentialRef === normalizeRef(id)) : -1;
    const existing = index >= 0 ? credentials[index] : null;
    const next = normalizeCredentialInput(input, existing, safeStorage);
    const updated = [...credentials];
    if (index >= 0) updated[index] = next;
    else updated.push(next);
    writeAll(updated);
    return metadataFromStored(next, safeStorage);
  }

  function deleteCredential(ref) {
    const normalized = normalizeRef(ref?.credentialRef ?? ref);
    const credentials = readAll();
    const updated = credentials.filter((entry) => entry.credentialRef !== normalized && entry.id !== idFromRef(normalized));
    writeAll(updated);
    return { deleted: updated.length !== credentials.length, credentialRef: normalized };
  }

  function getCredential(ref) {
    const normalized = normalizeRef(ref);
    if (!normalized) return null;
    return readAll().find((entry) => entry.credentialRef === normalized || entry.id === idFromRef(normalized)) ?? null;
  }

  function resolveSecret(ref) {
    const credential = getCredential(ref);
    if (!credential) throw new Error(`MCP credential not found: ${ref}`);
    return {
      metadata: metadataFromStored(credential, safeStorage),
      secret: decryptSecret(credential.secret, safeStorage),
    };
  }

  return {
    listCredentials,
    putCredential,
    deleteCredential,
    getCredential: (ref) => {
      const credential = getCredential(ref);
      return credential ? metadataFromStored(credential, safeStorage) : null;
    },
    resolveSecret,
    getOAuthCredential(ref) {
      const credential = getCredential(ref);
      if (!credential) throw new Error(`MCP credential not found: ${ref}`);
      if (credential.kind !== 'oauth2') throw new Error(`MCP credential ${ref} is not OAuth 2.0.`);
      const oauth = credential.oauth ?? {};
      return {
        metadata: metadataFromStored(credential, safeStorage),
        oauth: {
          ...oauth,
          tokens: revealJson(oauth.tokens, safeStorage),
          clientInformation: revealJson(oauth.clientInformation, safeStorage),
        },
      };
    },
    updateOAuthCredential(ref, patch = {}) {
      const credential = getCredential(ref);
      if (!credential) throw new Error(`MCP credential not found: ${ref}`);
      if (credential.kind !== 'oauth2') throw new Error(`MCP credential ${ref} is not OAuth 2.0.`);
      const credentials = readAll();
      const index = credentials.findIndex((entry) => entry.id === credential.id);
      if (index < 0) throw new Error(`MCP credential not found: ${ref}`);
      const updated = {
        ...credential,
        oauth: normalizeOAuthConfig(patch, credential.oauth ?? {}, safeStorage),
        updatedAt: nowIso(),
      };
      const next = [...credentials];
      next[index] = updated;
      writeAll(next);
      return metadataFromStored(updated, safeStorage);
    },
  };
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
    const { metadata, oauth } = credentialStore.getOAuthCredential(binding.credentialRef);
    ensureCompatible(metadata.kind, binding, server);
    return {
      headers: {},
      env: {},
      authProviderConfig: {
        credentialRef: metadata.credentialRef,
        oauth,
        updateOAuth: (patch) => credentialStore.updateOAuthCredential(metadata.credentialRef, patch),
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
