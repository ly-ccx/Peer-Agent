import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

export const CREDENTIAL_HELPER_PROTOCOL_VERSION = 1 as const;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;
const KEY_PATTERN = /^model\/[A-Za-z0-9._:-]+\/[A-Za-z0-9._:-]+$/;
const MCP_KEY_PATTERN = /^mcp\/[a-f0-9]{64}\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export type CredentialHelperRequest =
  | { readonly version: 1; readonly action: 'ping' }
  | { readonly version: 1; readonly action: 'get'; readonly key: string }
  | { readonly version: 1; readonly action: 'set'; readonly key: string; readonly secret: string }
  | { readonly version: 1; readonly action: 'delete'; readonly key: string }
  | { readonly version: 1; readonly action: 'get-snapshot'; readonly key: string }
  | { readonly version: 1; readonly action: 'compare-set'; readonly key: string; readonly expectedRevision: string | null; readonly secret: string | null };

interface CredentialHelperResponse {
  readonly version: 1;
  readonly ok: boolean;
  readonly data?: Record<string, unknown>;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export interface CredentialHelperTransport {
  invoke(request: CredentialHelperRequest): CredentialHelperResponse;
}

export class CredentialHelperError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CredentialHelperError';
    this.code = code;
  }
}

export interface CredentialHelperPathOptions {
  readonly explicitPath?: string;
  readonly resourcesPath?: string;
  readonly executablePath?: string;
  readonly repositoryRoot?: string;
  readonly platform?: NodeJS.Platform;
  readonly buildProfile?: 'debug' | 'release';
}

export function resolveCredentialHelperPath(
  options: CredentialHelperPathOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const filename = platform === 'win32'
    ? 'peer-credential-helper.exe'
    : 'peer-credential-helper';
  const explicitPath = options.explicitPath
    ?? process.env.PEER_CREDENTIAL_HELPER_PATH?.trim();
  const candidates = [
    explicitPath,
    options.resourcesPath ? path.join(options.resourcesPath, 'bin', filename) : undefined,
    options.resourcesPath ? path.join(options.resourcesPath, filename) : undefined,
    options.executablePath ? path.join(path.dirname(options.executablePath), filename) : undefined,
    options.repositoryRoot
      ? path.join(
        options.repositoryRoot,
        'target',
        options.buildProfile ?? 'debug',
        filename,
      )
      : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));

  const resolved = candidates.find((candidate) => existsSync(candidate));
  if (!resolved) {
    throw new CredentialHelperError(
      'credential_helper_not_found',
      'The Peer Agent credential helper is not installed.',
    );
  }
  return resolved;
}

export interface SubprocessTransportOptions extends CredentialHelperPathOptions {
  readonly dataHome?: string;
  readonly timeoutMs?: number;
  readonly maxBufferBytes?: number;
  readonly runner?: (
    command: string,
    args: readonly string[],
    options: Parameters<typeof spawnSync>[2],
  ) => SpawnSyncReturns<Buffer>;
}

export function createSubprocessCredentialTransport(
  options: SubprocessTransportOptions = {},
): CredentialHelperTransport {
  const helperPath = resolveCredentialHelperPath(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  const runner = options.runner ?? ((command, args, spawnOptions) =>
    spawnSync(command, [...args], spawnOptions) as SpawnSyncReturns<Buffer>);

  return {
    invoke(request) {
      validateRequest(request);
      const result = runner(helperPath, [], {
        input: Buffer.from(JSON.stringify(request), 'utf8'),
        encoding: 'buffer',
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer,
        env: {
          ...process.env,
          ...(options.dataHome ? { PEER_AGENT_HOME: options.dataHome } : {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      if (result.error) {
        const code = (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
          ? 'credential_helper_timeout'
          : 'credential_helper_unavailable';
        throw new CredentialHelperError(
          code,
          code === 'credential_helper_timeout'
            ? 'The credential helper timed out.'
            : 'The credential helper could not be started.',
        );
      }

      const response = parseResponse(result.stdout);
      if (!response.ok) {
        throw new CredentialHelperError(
          response.error?.code ?? 'credential_helper_failed',
          response.error?.message ?? 'The credential helper request failed.',
        );
      }
      if (result.status !== 0) {
        throw new CredentialHelperError(
          'credential_helper_failed',
          'The credential helper request failed.',
        );
      }
      return response;
    },
  };
}

export class CredentialHelperClient {
  private readonly transport: CredentialHelperTransport;

  constructor(transport: CredentialHelperTransport) {
    this.transport = transport;
  }

  ping(): { readonly status: string; readonly platform?: string } {
    const response = this.transport.invoke({
      version: CREDENTIAL_HELPER_PROTOCOL_VERSION,
      action: 'ping',
    });
    return {
      status: readString(response.data, 'status'),
      platform: readOptionalString(response.data, 'platform'),
    };
  }

  getSecret(key: string): string | null {
    validateCredentialKey(key);
    const response = this.transport.invoke({
      version: CREDENTIAL_HELPER_PROTOCOL_VERSION,
      action: 'get',
      key,
    });
    const secret = readNullableString(response.data, 'secret');
    if (key.endsWith('/oauth-tokens') && secret) {
      let parsed: unknown; try { parsed = JSON.parse(secret); } catch { /* opaque legacy values remain unchanged */ }
      if (isRecord(parsed) && Object.hasOwn(parsed, 'peerModelRefresh')) throw new CredentialHelperError('credential_oauth_refresh_pending', 'A model OAuth refresh is unresolved; sign in again.');
    }
    return secret;
  }

  setSecret(key: string, secret: string): void {
    validateCredentialKey(key);
    if (!secret) {
      throw new CredentialHelperError(
        'credential_secret_invalid',
        'Credential secrets cannot be empty.',
      );
    }
    this.transport.invoke({
      version: CREDENTIAL_HELPER_PROTOCOL_VERSION,
      action: 'set',
      key,
      secret,
    });
  }

  deleteSecret(key: string): boolean {
    validateCredentialKey(key);
    const response = this.transport.invoke({
      version: CREDENTIAL_HELPER_PROTOCOL_VERSION,
      action: 'delete',
      key,
    });
    return readBoolean(response.data, 'deleted');
  }

  supportsModelOAuthCas(): boolean {
    const response = this.transport.invoke({version: 1, action: 'ping'});
    readString(response.data, 'status');
    return Array.isArray(response.data?.features) && response.data.features.includes('model-oauth-cas-v1');
  }

  getSnapshot(key: string): {readonly secret: string | null; readonly revision: string | null} {
    validateOAuthKey(key);
    const response = this.transport.invoke({version: 1, action: 'get-snapshot', key});
    const secret = readNullableString(response.data, 'secret');
    const revision = readNullableString(response.data, 'revision');
    if ((secret === null) !== (revision === null) || (revision !== null && !validRevision(revision))) throwInvalidResponse();
    return {secret, revision};
  }

  compareSet(key: string, expectedRevision: string | null, secret: string | null): boolean {
    validateOAuthKey(key);
    if (expectedRevision !== null && !validRevision(expectedRevision)) throwInvalidResponse();
    if (secret === '') throw new CredentialHelperError('credential_secret_invalid', 'Credential secrets cannot be empty.');
    const response = this.transport.invoke({version: 1, action: 'compare-set', key, expectedRevision, secret});
    const applied = readBoolean(response.data, 'applied');
    const revision = readNullableString(response.data, 'revision');
    if ((applied && secret !== null) ? revision === null || !validRevision(revision) : revision !== null) throwInvalidResponse();
    return applied;
  }
}
function validRevision(value: string): boolean { return /^[A-Za-z0-9+/]{16}$/.test(value); }
function validateOAuthKey(key: string): void {
  validateCredentialKey(key);
  if (!key.startsWith('model/') || !key.endsWith('/oauth-tokens')) throw new CredentialHelperError('credential_key_namespace_denied', 'This operation requires a model OAuth key.');
}

export function modelApiKeyCredentialKey(providerId: string): string {
  return modelCredentialKey(providerId, 'api-key');
}

export function modelOauthCredentialKey(providerId: string): string {
  return modelCredentialKey(providerId, 'oauth-tokens');
}

function modelCredentialKey(providerId: string, kind: string): string {
  const key = `model/${providerId}/${kind}`;
  validateCredentialKey(key);
  return key;
}

function validateRequest(request: CredentialHelperRequest): void {
  if (request.version !== CREDENTIAL_HELPER_PROTOCOL_VERSION) {
    throw new CredentialHelperError(
      'protocol_version_unsupported',
      'The credential helper protocol version is unsupported.',
    );
  }
  if ('key' in request) validateCredentialKey(request.key);
  if (request.action === 'get-snapshot' || request.action === 'compare-set') validateOAuthKey(request.key);
  if (request.action === 'compare-set' && ((request.expectedRevision !== null && !validRevision(request.expectedRevision)) || request.secret === '')) {
    throw new CredentialHelperError('credential_request_invalid', 'The conditional credential request is invalid.');
  }
  if (request.action === 'set' && !request.secret) {
    throw new CredentialHelperError(
      'credential_secret_invalid',
      'Credential secrets cannot be empty.',
    );
  }
}

function validateCredentialKey(key: string): void {
  if (key.length > 240 || (!KEY_PATTERN.test(key) && !MCP_KEY_PATTERN.test(key)) || key.includes('..')) {
    throw new CredentialHelperError(
      'credential_key_invalid',
      'The credential key is invalid.',
    );
  }
}

function parseResponse(stdout: Buffer | string | null): CredentialHelperResponse {
  if (!stdout) {
    throw new CredentialHelperError(
      'credential_helper_response_invalid',
      'The credential helper returned no response.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.isBuffer(stdout) ? stdout.toString('utf8') : stdout);
  } catch {
    throw new CredentialHelperError(
      'credential_helper_response_invalid',
      'The credential helper returned an invalid response.',
    );
  }
  if (!isRecord(parsed)
      || parsed.version !== CREDENTIAL_HELPER_PROTOCOL_VERSION
      || typeof parsed.ok !== 'boolean') {
    throw new CredentialHelperError(
      'credential_helper_response_invalid',
      'The credential helper returned an incompatible response.',
    );
  }
  return parsed as unknown as CredentialHelperResponse;
}

function readString(data: Record<string, unknown> | undefined, key: string): string {
  const value = data?.[key];
  if (typeof value !== 'string') throwInvalidResponse();
  return value;
}

function readOptionalString(
  data: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = data?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throwInvalidResponse();
  return value;
}

function readNullableString(
  data: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = data?.[key];
  if (value === null) return null;
  if (typeof value !== 'string') throwInvalidResponse();
  return value;
}

function readBoolean(data: Record<string, unknown> | undefined, key: string): boolean {
  const value = data?.[key];
  if (typeof value !== 'boolean') throwInvalidResponse();
  return value;
}

function throwInvalidResponse(): never {
  throw new CredentialHelperError(
    'credential_helper_response_invalid',
    'The credential helper returned an invalid response.',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
