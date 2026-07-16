import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type SharedModelAuthMethod =
  | 'api_key'
  | 'oauth_chatgpt'
  | 'oauth_google'
  | 'oauth_grok'
  | 'qoder_local_auth';

export interface StoredModelProvider {
  readonly id?: string;
  readonly groupId?: string;
  readonly name?: string;
  readonly provider?: string;
  readonly channelId?: string;
  readonly authMethod?: SharedModelAuthMethod;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly enabled?: boolean;
  readonly isDefault?: boolean;
  readonly apiKeyConfigured?: boolean;
  readonly oauthConfigured?: boolean;
  readonly oauthExpires?: number;
  readonly oauthAccountId?: string;
}

export interface ChatGptOAuthTokens {
  readonly access: string;
  readonly refresh?: string;
  readonly expires?: number;
  readonly accountId?: string;
}

export interface SharedModelCredentialStore {
  getApiKey(credentialId: string): string | null;
  getOAuthTokens(credentialId: string): ChatGptOAuthTokens | null;
  setOAuthTokens(credentialId: string, tokens: ChatGptOAuthTokens | null): void;
}

export interface SharedModelMetadata {
  readonly source: 'desktop-default';
  readonly providerId: string;
  readonly credentialId: string;
  readonly displayName: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly authMethod: SharedModelAuthMethod;
  readonly credentialStored: boolean;
  readonly configFile: string;
}

export interface SharedModelSelection extends SharedModelMetadata {
  readonly apiKey?: string;
  readonly oauthTokens?: ChatGptOAuthTokens;
  persistOAuthTokens(tokens: ChatGptOAuthTokens): void;
}

export interface LoadSharedModelSelectionOptions {
  readonly userDataPath?: string;
  readonly readFile?: (file: string) => string;
  readonly credentialStore?: SharedModelCredentialStore;
  /** Select a specific configured provider instead of the desktop default. */
  readonly credentialId?: string;
  readonly writeProviders?: (
    file: string,
    providers: readonly StoredModelProvider[],
  ) => void;
}

export function getSharedModelConfigPath(
  userDataPath = path.join(os.homedir(), '.peer-agent'),
): string {
  return path.join(userDataPath, 'llm-providers.json');
}

function parseProviders(content: string): StoredModelProvider[] {
  const parsed: unknown = JSON.parse(content);
  if (Array.isArray(parsed)) return parsed as StoredModelProvider[];
  if (
    parsed
    && typeof parsed === 'object'
    && Array.isArray((parsed as { providers?: unknown }).providers)
  ) {
    return (parsed as { providers: StoredModelProvider[] }).providers;
  }
  return [];
}

function normalizedAuthMethod(provider: StoredModelProvider): SharedModelAuthMethod {
  if (
    provider.authMethod === 'oauth_chatgpt'
    || provider.authMethod === 'oauth_google'
    || provider.authMethod === 'oauth_grok'
    || provider.authMethod === 'qoder_local_auth'
  ) {
    return provider.authMethod;
  }
  return 'api_key';
}

function credentialIdOf(provider: StoredModelProvider): string {
  return provider.groupId?.trim() || provider.id?.trim() || '';
}

function hasStoredCredential(provider: StoredModelProvider): boolean {
  const authMethod = normalizedAuthMethod(provider);
  if (authMethod === 'qoder_local_auth') return true;
  if (!credentialIdOf(provider)) return false;
  if (
    authMethod === 'oauth_chatgpt'
    || authMethod === 'oauth_google'
    || authMethod === 'oauth_grok'
  ) {
    return provider.oauthConfigured === true;
  }
  return provider.apiKeyConfigured === true;
}

export function selectDesktopDefaultProvider(
  providers: readonly StoredModelProvider[],
): StoredModelProvider | null {
  const enabled = providers.filter(
    (provider) => provider.enabled !== false && provider.model?.trim(),
  );
  return enabled.find((provider) => provider.isDefault && hasStoredCredential(provider))
    ?? enabled.find((provider) => hasStoredCredential(provider))
    ?? enabled.find((provider) => provider.isDefault)
    ?? enabled[0]
    ?? null;
}

function selectedProvider(options: LoadSharedModelSelectionOptions): {
  readonly configFile: string;
  readonly read: (file: string) => string;
  readonly selected: StoredModelProvider;
} | null {
  const configFile = getSharedModelConfigPath(options.userDataPath);
  if (!existsSync(configFile)) return null;
  const read = options.readFile ?? ((file: string) => readFileSync(file, 'utf8'));
  const providers = parseProviders(read(configFile));
  const selected = options.credentialId
    ? providers.find((provider) =>
        provider.enabled !== false
        && provider.model?.trim()
        && credentialIdOf(provider) === options.credentialId)
      ?? null
    : selectDesktopDefaultProvider(providers);
  return selected?.model ? { configFile, read, selected } : null;
}

function metadataFromSelected(
  configFile: string,
  selected: StoredModelProvider,
): SharedModelMetadata {
  return {
    source: 'desktop-default',
    providerId: selected.provider?.trim() || 'openai',
    credentialId: credentialIdOf(selected),
    displayName: selected.name?.trim() || selected.model?.trim() || 'Desktop default',
    model: selected.model?.trim() || '',
    baseUrl: selected.baseUrl?.trim() || 'https://api.openai.com/v1',
    authMethod: normalizedAuthMethod(selected),
    credentialStored: hasStoredCredential(selected),
    configFile,
  };
}

function writeProvidersAtomically(
  configFile: string,
  providers: readonly StoredModelProvider[],
): void {
  const temporaryFile = path.join(
    path.dirname(configFile),
    `.${path.basename(configFile)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryFile, 'wx', 0o600);
    writeFileSync(descriptor, JSON.stringify(providers, null, 2), 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryFile, configFile);
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* best effort */ }
    }
    try { unlinkSync(temporaryFile); } catch { /* best effort */ }
    throw error;
  }
}

export function loadSharedModelMetadata(
  options: LoadSharedModelSelectionOptions = {},
): SharedModelMetadata | null {
  const found = selectedProvider(options);
  return found ? metadataFromSelected(found.configFile, found.selected) : null;
}

/** Lists every enabled desktop provider that has a model and stored credential. */
export function loadSharedModelMetadataList(
  options: Pick<LoadSharedModelSelectionOptions, 'userDataPath' | 'readFile'> = {},
): readonly SharedModelMetadata[] {
  const configFile = getSharedModelConfigPath(options.userDataPath);
  if (!existsSync(configFile)) return [];
  const read = options.readFile ?? ((file: string) => readFileSync(file, 'utf8'));
  return parseProviders(read(configFile))
    .filter((provider) => provider.enabled !== false && provider.model?.trim() && hasStoredCredential(provider))
    .map((provider) => metadataFromSelected(configFile, provider));
}

export function loadSharedModelSelection(
  options: LoadSharedModelSelectionOptions = {},
): SharedModelSelection | null {
  const found = selectedProvider(options);
  if (!found || !options.credentialStore) return null;
  const { configFile, read, selected } = found;
  const authMethod = normalizedAuthMethod(selected);
  if (
    authMethod === 'oauth_google'
    || authMethod === 'oauth_grok'
    || authMethod === 'qoder_local_auth'
  ) {
    return null;
  }

  const credentialId = credentialIdOf(selected);
  if (!credentialId) return null;
  const apiKey = authMethod === 'api_key'
    ? options.credentialStore.getApiKey(credentialId)
    : undefined;
  const oauthTokens = authMethod === 'oauth_chatgpt'
    ? options.credentialStore.getOAuthTokens(credentialId)
    : undefined;
  if (authMethod === 'api_key' && !apiKey) return null;
  if (authMethod === 'oauth_chatgpt' && !oauthTokens?.access) return null;

  return {
    ...metadataFromSelected(configFile, selected),
    ...(apiKey ? { apiKey } : {}),
    ...(oauthTokens ? { oauthTokens } : {}),
    persistOAuthTokens(tokens) {
      if (authMethod !== 'oauth_chatgpt') return;
      const previousTokens = options.credentialStore?.getOAuthTokens(credentialId) ?? null;
      options.credentialStore?.setOAuthTokens(credentialId, tokens);
      try {
        const current = parseProviders(read(configFile));
        const updated = current.map((provider) => credentialIdOf(provider) === credentialId
          ? {
              ...provider,
              oauthConfigured: Boolean(tokens.access),
              oauthExpires: typeof tokens.expires === 'number' ? tokens.expires : undefined,
              oauthAccountId: tokens.accountId || undefined,
            }
          : provider);
        (options.writeProviders ?? writeProvidersAtomically)(configFile, updated);
      } catch (error) {
        try {
          options.credentialStore?.setOAuthTokens(credentialId, previousTokens);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            'shared_model_credential_rollback_failed',
          );
        }
        throw error;
      }
    },
  };
}
