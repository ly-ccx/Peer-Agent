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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function groupKeyOf(provider: Pick<StoredModelProvider, 'groupId' | 'id'>): string {
  return provider.groupId?.trim() || provider.id?.trim() || '';
}

/**
 * Desktop stores llm-providers.json either as:
 * - legacy flat array / { providers: [...] }
 * - v2 { version: 2, channels: [...], models: [...] }
 *
 * Shared readers always expand to the flat provider/model row shape so TUI and
 * Desktop can share the same selection helpers.
 */
function parseProviders(content: string): StoredModelProvider[] {
  const parsed: unknown = JSON.parse(content);
  if (Array.isArray(parsed)) return parsed as StoredModelProvider[];
  if (!isRecord(parsed)) return [];

  if (Array.isArray(parsed.providers)) {
    return parsed.providers as StoredModelProvider[];
  }

  if (Array.isArray(parsed.channels) && Array.isArray(parsed.models)) {
    const channels = new Map<string, StoredModelProvider>();
    for (const channel of parsed.channels as StoredModelProvider[]) {
      const key = groupKeyOf(channel);
      if (!key) continue;
      channels.set(key, {
        ...channel,
        id: key,
        groupId: key,
      });
    }

    const providers: StoredModelProvider[] = [];
    for (const model of parsed.models as StoredModelProvider[]) {
      const key = groupKeyOf(model);
      const channel = channels.get(key);
      if (!channel) continue;
      providers.push({
        ...channel,
        ...model,
        id: model.id ?? key,
        groupId: key,
      });
    }
    return providers;
  }

  return [];
}

const MODEL_ONLY_FIELDS = new Set([
  'model',
  'modelLabel',
  'metadataSource',
  'pricingSource',
  'metadataSyncedAt',
  'contextWindow',
  'maxOutputTokens',
  'modelOptions',
  'modelOptionValues',
  'inputPrice',
  'outputPrice',
  'cacheWritePrice',
  'cacheReadPrice',
  'longContextInputThreshold',
  'longContextInputPrice',
  'longContextCacheReadPrice',
  'supportsVision',
  'supportsReasoning',
  'supportsPromptCaching',
  'reasoningEffortLevels',
  'reasoningParamStyle',
  'enabled',
  'isDefault',
]);

function channelFromProvider(provider: StoredModelProvider): StoredModelProvider {
  const channel: Record<string, unknown> = {
    ...provider,
    id: groupKeyOf(provider),
    groupId: groupKeyOf(provider),
  };
  for (const field of MODEL_ONLY_FIELDS) {
    delete channel[field];
  }
  return channel as StoredModelProvider;
}

function modelFromProvider(provider: StoredModelProvider): StoredModelProvider {
  const groupId = groupKeyOf(provider);
  const model: Record<string, unknown> = {
    id: provider.id ?? groupId,
    groupId,
    model: provider.model,
    enabled: provider.enabled !== false,
    isDefault: provider.isDefault === true,
  };
  for (const field of MODEL_ONLY_FIELDS) {
    if (field === 'enabled' || field === 'isDefault' || field === 'model') continue;
    const value = (provider as Record<string, unknown>)[field];
    if (value !== undefined) model[field] = value;
  }
  return model as StoredModelProvider;
}

function serializeProvidersDocument(
  providers: readonly StoredModelProvider[],
  previousContent: string | null,
): string {
  if (previousContent) {
    try {
      const previous = JSON.parse(previousContent) as unknown;
      if (
        isRecord(previous)
        && Array.isArray(previous.channels)
        && Array.isArray(previous.models)
      ) {
        const channels = new Map<string, StoredModelProvider>();
        for (const channel of previous.channels as StoredModelProvider[]) {
          const key = groupKeyOf(channel);
          if (key) channels.set(key, { ...channel, id: key, groupId: key });
        }
        for (const provider of providers) {
          const key = groupKeyOf(provider);
          if (!key) continue;
          channels.set(key, {
            ...(channels.get(key) ?? {}),
            ...channelFromProvider(provider),
          });
        }

        const modelsById = new Map<string, StoredModelProvider>();
        for (const model of previous.models as StoredModelProvider[]) {
          const id = model.id?.trim() || groupKeyOf(model);
          if (id) modelsById.set(id, model);
        }
        for (const provider of providers) {
          const id = provider.id?.trim() || groupKeyOf(provider);
          if (!id) continue;
          modelsById.set(id, {
            ...(modelsById.get(id) ?? {}),
            ...modelFromProvider(provider),
          });
        }

        return `${JSON.stringify({
          version: 2,
          channels: [...channels.values()],
          models: [...modelsById.values()],
        }, null, 2)}\n`;
      }
    } catch {
      // Fall through to legacy array serialization.
    }
  }

  return `${JSON.stringify(providers, null, 2)}\n`;
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
    const previousContent = existsSync(configFile)
      ? readFileSync(configFile, 'utf8')
      : null;
    descriptor = openSync(temporaryFile, 'wx', 0o600);
    writeFileSync(
      descriptor,
      serializeProvidersDocument(providers, previousContent),
      'utf8',
    );
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
