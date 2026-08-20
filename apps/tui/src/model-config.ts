import {
  loadSharedModelMetadata,
  loadSharedModelMetadataList,
  loadSharedModelSelection,
  type RuntimeModelCatalogEntry,
  type ModelCredential,
  type ModelCredentialPort,
  type ModelCredentialRequest,
  type SharedModelCredentialStore,
  type SharedModelMetadata,
  type SharedModelSelection,
} from '@peer-agent/runtime-node';

import { createTuiSharedModelCredentialStore } from './model-credential-store.ts';

export const TUI_MODEL_ENV = {
  apiKey: 'PEER_MODEL_API_KEY',
  baseUrl: 'PEER_MODEL_BASE_URL',
  model: 'PEER_MODEL_ID',
} as const;

export interface TuiModelEnvironment {
  readonly [key: string]: string | undefined;
}

export interface TuiModelConfig {
  readonly providerId: string;
  readonly model: string;
  readonly modelLabel: string;
  readonly source: 'environment' | 'desktop-default' | 'unconfigured';
  readonly configured: boolean;
  readonly credentials: ModelCredentialPort;
  readonly catalog: readonly RuntimeModelCatalogEntry[];
  readonly sharedMetadata?: SharedModelMetadata;
  readonly sharedProviders?: readonly SharedModelMetadata[];
  readonly resolveSharedSelection?: (credentialId?: string) => SharedModelSelection | null;
}

function value(environment: TuiModelEnvironment, name: string): string | undefined {
  const candidate = environment[name]?.trim();
  return candidate ? candidate : undefined;
}

export function createEnvironmentCredentialPort(
  environment: TuiModelEnvironment,
): ModelCredentialPort {
  return {
    async resolve(request: ModelCredentialRequest): Promise<ModelCredential | null> {
      return environmentCredentialOf(environment, request.providerId);
    },
    /** 同步读取 env 凭证（同步构造 provider 时使用，如 tui-runtime 的种子 provider）。 */
    environmentCredential(providerId: string): ModelCredential | null {
      return environmentCredentialOf(environment, providerId);
    },
  };
}

function environmentCredentialOf(
  environment: TuiModelEnvironment,
  providerId: string,
): ModelCredential | null {
  if (providerId !== 'openai-compatible') return null;
  const apiKey = value(environment, TUI_MODEL_ENV.apiKey);
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: value(environment, TUI_MODEL_ENV.baseUrl),
  };
}

export function resolveTuiModelConfig(
  environment: TuiModelEnvironment,
  options: {
    readonly userDataPath?: string;
    readonly sharedCredentialStore?: SharedModelCredentialStore;
    readonly loadSharedMetadata?: typeof loadSharedModelMetadata;
    readonly loadSharedMetadataList?: typeof loadSharedModelMetadataList;
    readonly loadSharedSelection?: typeof loadSharedModelSelection;
  } = {},
): TuiModelConfig {
  const credentials = createEnvironmentCredentialPort(environment);
  const environmentApiKey = value(environment, TUI_MODEL_ENV.apiKey);
  if (environmentApiKey) {
    const model = value(environment, TUI_MODEL_ENV.model) ?? 'gpt-4o-mini';
    return {
      providerId: 'openai-compatible',
      model,
      modelLabel: `${model} · env`,
      source: 'environment',
      configured: true,
      credentials,
      catalog: [{
        providerId: 'openai-compatible', modelId: model, displayName: model,
        supportsTools: true,
        // Align with Desktop BASE fallback when no Desktop catalog is present.
        supportedReasoningEfforts: ['off', 'low', 'default', 'high'],
        defaultReasoningEffort: 'default',
        available: true,
      }],
    };
  }

  const sharedProviders = (options.loadSharedMetadataList ?? loadSharedModelMetadataList)({
    userDataPath: options.userDataPath,
  });
  // Keep the full Desktop catalog visible and selectable in CLI when credentials
  // are present. Auth-method-specific request routing lives in tui-runtime.ts.
  const catalog = sharedProviders.map((provider): RuntimeModelCatalogEntry => {
    const available = provider.credentialStored;
    // Prefer Desktop modelLabel (e.g. GLM-5.2) over raw model id (e.g. gm51model).
    const modelDisplay = provider.modelLabel?.trim() || provider.model;
    return {
      providerId: provider.credentialId,
      modelId: provider.model,
      // Desktop conversation meta may bind by the model entry uuid; keep it so
      // resume paths can map that binding back to this groupId-keyed entry.
      ...(provider.entryId ? { entryId: provider.entryId } : {}),
      displayName: `${modelDisplay} · ${provider.displayName}`,
      // Prefer Desktop llm-providers.json contextWindow so status bar can
      // render `ctx N%` instead of falling back to `ctx N / ?`.
      ...(provider.contextWindow === undefined ? {} : { contextWindow: provider.contextWindow }),
      supportsTools: true,
      supportedReasoningEfforts: provider.supportedReasoningEfforts,
      defaultReasoningEffort: provider.defaultReasoningEffort,
      available,
      ...(available ? {} : { unavailableReason: 'credential missing' }),
    };
  });

  // Prefer the Desktop default when credentials exist; otherwise fall back to
  // the first credentialed provider so the model picker stays usable.
  const preferredSharedMetadata = (options.loadSharedMetadata ?? loadSharedModelMetadata)({
    userDataPath: options.userDataPath,
  });
  const sharedMetadata = (
    preferredSharedMetadata
    && preferredSharedMetadata.credentialStored
  )
    ? preferredSharedMetadata
    : (sharedProviders.find((provider) => provider.credentialStored) ?? null);

  if (sharedMetadata) {
    const sharedCredentialStore = options.sharedCredentialStore
      ?? (options.userDataPath
        ? createTuiSharedModelCredentialStore({ dataHome: options.userDataPath })
        : undefined);
    const modelDisplay = sharedMetadata.modelLabel?.trim() || sharedMetadata.model;
    return {
      providerId: sharedMetadata.credentialId,
      model: sharedMetadata.model,
      modelLabel: `${modelDisplay} · desktop default`,
      source: 'desktop-default',
      configured: sharedMetadata.credentialStored,
      credentials,
      catalog,
      sharedMetadata,
      sharedProviders,
      resolveSharedSelection: (credentialId = sharedMetadata.credentialId) =>
        (options.loadSharedSelection ?? loadSharedModelSelection)({
          userDataPath: options.userDataPath,
          credentialId,
          credentialStore: sharedCredentialStore,
        }),
    };
  }

  const model = value(environment, TUI_MODEL_ENV.model) ?? 'gpt-4o-mini';
  return {
    providerId: 'openai-compatible',
    model,
    modelLabel: 'model not configured',
    source: 'unconfigured',
    configured: false,
    credentials,
    catalog: [],
  };
}

export function missingModelConfigurationMessage(): string {
  return [
    'No model credential configured.',
    `Set ${TUI_MODEL_ENV.apiKey}; optionally set ${TUI_MODEL_ENV.baseUrl} and ${TUI_MODEL_ENV.model}.`,
  ].join(' ');
}
