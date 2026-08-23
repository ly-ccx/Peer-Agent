import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CredentialHelperClient,
  createSubprocessCredentialTransport,
  modelApiKeyCredentialKey,
  modelOauthCredentialKey,
} from '@peer-agent/credential-helper';
import type {
  ChatGptOAuthTokens,
  SharedModelCredentialStore,
} from '@peer-agent/runtime-node';

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIRECTORY, '../../..');

export interface TuiCredentialClient {
  getSecret(key: string): string | null;
  setSecret(key: string, value: string): void;
  deleteSecret(key: string): boolean;
}

export interface CreateTuiSharedModelCredentialStoreOptions {
  readonly dataHome: string;
  readonly client?: TuiCredentialClient;
  readonly executablePath?: string;
  readonly repositoryRoot?: string;
  readonly buildProfile?: 'debug' | 'release';
}

function optionalTokenString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function parseOAuthTokens(raw: string | null): ChatGptOAuthTokens | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('credential_oauth_tokens_invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('credential_oauth_tokens_invalid');
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.access !== 'string' || !record.access) {
    throw new Error('credential_oauth_tokens_invalid');
  }
  const refresh = optionalTokenString(record.refresh);
  const accountId = optionalTokenString(record.accountId);
  const scope = optionalTokenString(record.scope);
  const issuer = optionalTokenString(record.issuer);
  const clientId = optionalTokenString(record.clientId);
  return {
    access: record.access,
    ...(refresh ? { refresh } : {}),
    ...(typeof record.expires === 'number' && Number.isFinite(record.expires)
      ? { expires: record.expires }
      : {}),
    ...(accountId ? { accountId } : {}),
    ...(scope ? { scope } : {}),
    ...(issuer ? { issuer } : {}),
    ...(clientId ? { clientId } : {}),
  };
}

function secretsEqual(left: string, right: string | null): boolean {
  if (right === null) return false;
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function createTuiSharedModelCredentialStore(
  options: CreateTuiSharedModelCredentialStoreOptions,
): SharedModelCredentialStore {
  let productionClient: TuiCredentialClient | undefined;
  const credentials = (): TuiCredentialClient => {
    if (options.client) return options.client;
    const client = productionClient ?? new CredentialHelperClient(
      createSubprocessCredentialTransport({
        dataHome: options.dataHome,
        executablePath: options.executablePath ?? process.execPath,
        repositoryRoot: options.repositoryRoot ?? REPOSITORY_ROOT,
        buildProfile: options.buildProfile
          ?? (process.env.NODE_ENV === 'production' ? 'release' : 'debug'),
      }),
    );
    productionClient = client;
    return client;
  };

  return {
    getApiKey(credentialId) {
      return credentials().getSecret(modelApiKeyCredentialKey(credentialId));
    },
    getOAuthTokens(credentialId) {
      return parseOAuthTokens(
        credentials().getSecret(modelOauthCredentialKey(credentialId)),
      );
    },
    setOAuthTokens(credentialId, tokens) {
      const key = modelOauthCredentialKey(credentialId);
      if (!tokens) {
        credentials().deleteSecret(key);
        if (credentials().getSecret(key) !== null) {
          throw new Error('credential_delete_verify_failed');
        }
        return;
      }
      const serialized = JSON.stringify(tokens);
      credentials().setSecret(key, serialized);
      if (!secretsEqual(serialized, credentials().getSecret(key))) {
        throw new Error('credential_write_verify_failed');
      }
    },
  };
}
