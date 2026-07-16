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
      if (request.providerId !== 'openai-compatible') return null;
      const apiKey = value(environment, TUI_MODEL_ENV.apiKey);
      if (!apiKey) return null;
      return {
        apiKey,
        baseUrl: value(environment, TUI_MODEL_ENV.baseUrl),
      };
    },
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
        supportsTools: true, supportedReasoningEfforts: ['default', 'low', 'high'],
        defaultReasoningEffort: 'default', available: true,
      }],
    };
  }

  const sharedMetadata = (options.loadSharedMetadata ?? loadSharedModelMetadata)({
    userDataPath: options.userDataPath,
  });
  if (sharedMetadata) {
    const sharedProviders = (options.loadSharedMetadataList ?? loadSharedModelMetadataList)({
      userDataPath: options.userDataPath,
    });
    const catalog = sharedProviders
      .filter((provider) => provider.authMethod === 'api_key' || provider.authMethod === 'oauth_chatgpt')
      .map((provider): RuntimeModelCatalogEntry => ({
        providerId: provider.credentialId,
        modelId: provider.model,
        displayName: `${provider.model} · ${provider.displayName}`,
        supportsTools: true,
        supportedReasoningEfforts: ['default', 'low', 'high'],
        defaultReasoningEffort: 'default',
        available: provider.credentialStored,
      }));
    const sharedCredentialStore = options.sharedCredentialStore
      ?? (options.userDataPath
        ? createTuiSharedModelCredentialStore({ dataHome: options.userDataPath })
        : undefined);
    return {
      providerId: sharedMetadata.credentialId,
      model: sharedMetadata.model,
      modelLabel: `${sharedMetadata.model} · desktop default`,
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
