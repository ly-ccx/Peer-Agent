import electron from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathOf } from './data-store.mjs';

const VERSION = 1;
const CREDENTIAL_PREFIX = 'mcp-cred:';
const SUPPORTED_KINDS = new Set(['http_bearer', 'http_header', 'stdio_env']);
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
  return kind === 'stdio_env' ? 'env' : 'header';
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

function normalizeStoredCredential(entry) {
  const id = asString(entry?.id) || randomUUID();
  const kind = SUPPORTED_KINDS.has(entry?.kind) ? entry.kind : 'http_bearer';
  const createdAt = asString(entry?.createdAt) || nowIso();
  const updatedAt = asString(entry?.updatedAt) || createdAt;
  return {
    id,
    credentialRef: normalizeRef(entry?.credentialRef ?? id),
    label: asString(entry?.label) || 'MCP credential',
    kind,
    target: targetForKind(kind),
    headerName: kind === 'http_header' ? validateHeaderName(entry?.headerName) : undefined,
    envName: kind === 'stdio_env' ? validateEnvName(entry?.envName) : undefined,
    secret: entry?.secret && typeof entry.secret === 'object' ? entry.secret : encryptSecret('', null),
    lastFour: asString(entry?.lastFour),
    storage: entry?.secret?.scheme === SAFE_STORAGE_SCHEME ? 'safeStorage' : 'file-fallback',
    createdAt,
    updatedAt,
  };
}

function metadataFromStored(entry) {
  return {
    id: entry.id,
    credentialRef: entry.credentialRef,
    label: entry.label,
    kind: entry.kind,
    target: entry.target,
    headerName: entry.headerName,
    envName: entry.envName,
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
  const hasSecret = Object.prototype.hasOwnProperty.call(input, 'secret');
  if (!hasSecret && !existing) throw new Error('MCP credential secret is required.');
  const secretValue = hasSecret ? String(input.secret ?? '') : null;
  if (hasSecret && secretValue.length === 0) throw new Error('MCP credential secret is required.');
  const headerName = kind === 'http_header'
    ? validateHeaderName(input.headerName ?? existing?.headerName)
    : undefined;
  const envName = kind === 'stdio_env'
    ? validateEnvName(input.envName ?? existing?.envName)
    : undefined;
  if (kind === 'http_header' && !headerName) throw new Error('MCP HTTP header credential requires headerName.');
  if (kind === 'stdio_env' && !envName) throw new Error('MCP stdio env credential requires envName.');

  const encryptedSecret = hasSecret ? encryptSecret(secretValue, safeStorage) : existing.secret;
  return {
    id,
    credentialRef: normalizeRef(id),
    label,
    kind,
    target: targetForKind(kind),
    headerName,
    envName,
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
  if ((kind === 'http_bearer' || kind === 'http_header') && transport === 'stdio') {
    throw new Error(`MCP auth mode ${kind} requires an HTTP MCP transport.`);
  }
  if (kind === 'stdio_env' && transport !== 'stdio') {
    throw new Error('MCP auth mode stdio_env requires a stdio MCP transport.');
  }
}

export function createMcpCredentialStore({ credentialFile = pathOf('mcpCredentials'), safeStorage = getSafeStorage() } = {}) {
  function readAll() {
    return loadCredentialFile(credentialFile).credentials.map(normalizeStoredCredential);
  }

  function writeAll(credentials) {
    writeCredentialFile(credentialFile, { credentials });
  }

  function listCredentials() {
    return readAll().map(metadataFromStored);
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
    return metadataFromStored(next);
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
      metadata: metadataFromStored(credential),
      secret: decryptSecret(credential.secret, safeStorage),
    };
  }

  return {
    listCredentials,
    putCredential,
    deleteCredential,
    getCredential: (ref) => {
      const credential = getCredential(ref);
      return credential ? metadataFromStored(credential) : null;
    },
    resolveSecret,
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
