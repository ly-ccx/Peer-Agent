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

import type { ModelReasoningEffort } from './model-catalog.ts';

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
  /** Human-readable model label from Desktop (e.g. GLM-5.2). */
  readonly modelLabel?: string;
  readonly baseUrl?: string;
  readonly enabled?: boolean;
  readonly isDefault?: boolean;
  readonly apiKeyConfigured?: boolean;
  readonly oauthConfigured?: boolean;
  readonly oauthExpires?: number;
  readonly oauthAccountId?: string;
  readonly oauthProjectId?: string | null;
  readonly contextWindow?: number;
  /** Desktop-projected reasoning levels for this model (e.g. off/low/default/high/xhigh). */
  readonly reasoningEffortLevels?: readonly string[];
  readonly reasoningDefaultEffort?: string;
  readonly reasoningParamStyle?: string;
  readonly supportsReasoning?: boolean;
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
  /** Desktop channel id when present (openai / anthropic / anthropic-compatible / qoder / ...). */
  readonly channelId?: string;
  readonly credentialId: string;
  readonly displayName: string;
  readonly model: string;
  /** Optional human-readable model label from Desktop (e.g. GLM-5.2). */
  readonly modelLabel?: string;
  readonly baseUrl: string;
  readonly authMethod: SharedModelAuthMethod;
  readonly credentialStored: boolean;
  readonly configFile: string;
  /** Optional context window from Desktop llm-providers.json model entry. */
  readonly contextWindow?: number;
  /**
   * Projected from Desktop llm-providers.json (model.reasoningEffortLevels).
   * Empty/missing levels fall back to the desktop BASE set.
   */
  readonly supportedReasoningEfforts: readonly ModelReasoningEffort[];
  readonly defaultReasoningEffort: ModelReasoningEffort;
}

export interface SharedModelSelection extends SharedModelMetadata {
  readonly apiKey?: string;
  readonly accountId?: string | null;
  readonly oauthProjectId?: string | null;
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

function normalizeContextWindow(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}


const CANONICAL_REASONING_EFFORT_ORDER: readonly ModelReasoningEffort[] = [
  'off',
  'low',
  'medium',
  'default',
  'high',
  'xhigh',
  'max',
];

const BASE_REASONING_EFFORT_LEVELS: readonly ModelReasoningEffort[] = [
  'off',
  'low',
  'default',
  'high',
];

function isModelReasoningEffort(value: string): value is ModelReasoningEffort {
  return (CANONICAL_REASONING_EFFORT_ORDER as readonly string[]).includes(value);
}

/**
 * Normalize Desktop-projected reasoningEffortLevels the same way the Desktop UI does:
 * keep declared legal levels, stable order, fall back to BASE when empty/invalid.
 */
export function normalizeReasoningEffortLevels(
  raw: readonly string[] | null | undefined,
): readonly ModelReasoningEffort[] {
  if (!raw || raw.length === 0) return BASE_REASONING_EFFORT_LEVELS;
  const valid = new Set<ModelReasoningEffort>();
  for (const item of raw) {
    if (typeof item === 'string' && isModelReasoningEffort(item)) valid.add(item);
  }
  const result = CANONICAL_REASONING_EFFORT_ORDER.filter((level) => valid.has(level));
  return result.length > 0 ? result : BASE_REASONING_EFFORT_LEVELS;
}

export function resolveDefaultReasoningEffort(
  levels: readonly ModelReasoningEffort[],
  preferred?: string | null,
): ModelReasoningEffort {
  if (preferred && isModelReasoningEffort(preferred) && levels.includes(preferred)) {
    return preferred;
  }
  // Align with Desktop resolvePreferredEffort: prefer high over the first listed
  // level so Grok (low/medium/high, channel default high) does not fall back to low.
  for (const candidate of ['high', 'default', 'medium', 'low'] as const) {
    if (levels.includes(candidate)) return candidate;
  }
  return levels[0] ?? 'default';
}

function metadataFromSelected(
  configFile: string,
  selected: StoredModelProvider,
): SharedModelMetadata {
  const contextWindow = normalizeContextWindow(selected.contextWindow);
  const modelLabel = selected.modelLabel?.trim() || undefined;
  const supportedReasoningEfforts = normalizeReasoningEffortLevels(
    selected.reasoningEffortLevels,
  );
  const defaultReasoningEffort = resolveDefaultReasoningEffort(
    supportedReasoningEfforts,
    selected.reasoningDefaultEffort,
  );
  const channelId = selected.channelId?.trim() || undefined;
  return {
    source: 'desktop-default',
    providerId: selected.provider?.trim() || 'openai',
    ...(channelId ? { channelId } : {}),
    credentialId: credentialIdOf(selected),
    displayName: selected.name?.trim() || selected.model?.trim() || 'Desktop default',
    model: selected.model?.trim() || '',
    ...(modelLabel ? { modelLabel } : {}),
    baseUrl: selected.baseUrl?.trim() || 'https://api.openai.com/v1',
    authMethod: normalizedAuthMethod(selected),
    credentialStored: hasStoredCredential(selected),
    configFile,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    supportedReasoningEfforts,
    defaultReasoningEffort,
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
  const credentialId = credentialIdOf(selected);
  if (!credentialId) return null;

  // All Desktop auth methods are selectable in CLI. Runtime adapters decide how
  // to refresh/use credentials; unsupported execution remains a provider concern.
  const apiKey = authMethod === 'api_key'
    ? options.credentialStore.getApiKey(credentialId)
    : undefined;
  const oauthTokens = (
    authMethod === 'oauth_chatgpt'
    || authMethod === 'oauth_google'
    || authMethod === 'oauth_grok'
  )
    ? options.credentialStore.getOAuthTokens(credentialId)
    : undefined;
  // qoder_local_auth loads its token from the external Qoder CLI at stream time.
  if (authMethod === 'api_key' && !apiKey) return null;
  if (
    (authMethod === 'oauth_chatgpt' || authMethod === 'oauth_google' || authMethod === 'oauth_grok')
    && !oauthTokens?.access
  ) {
    return null;
  }

  const accountId = selected.oauthAccountId ?? oauthTokens?.accountId ?? null;
  const oauthProjectId = selected.oauthProjectId ?? null;

  return {
    ...metadataFromSelected(configFile, selected),
    ...(apiKey ? { apiKey } : {}),
    ...(accountId ? { accountId } : { accountId: null }),
    ...(oauthProjectId ? { oauthProjectId } : { oauthProjectId: null }),
    ...(oauthTokens ? { oauthTokens } : {}),
    persistOAuthTokens(tokens) {
      if (
        authMethod !== 'oauth_chatgpt'
        && authMethod !== 'oauth_google'
        && authMethod !== 'oauth_grok'
      ) return;
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
