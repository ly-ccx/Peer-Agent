import type {
  ModelCredential,
  ModelCredentialPort,
  ModelCredentialRequest,
} from '@peer-agent/runtime-node';

export const TUI_MODEL_ENV = {
  apiKey: 'PEER_MODEL_API_KEY',
  baseUrl: 'PEER_MODEL_BASE_URL',
  model: 'PEER_MODEL_ID',
} as const;

export interface TuiModelEnvironment {
  readonly [key: string]: string | undefined;
}

export interface TuiModelConfig {
  readonly providerId: 'openai-compatible';
  readonly model: string;
  readonly configured: boolean;
  readonly credentials: ModelCredentialPort;
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
): TuiModelConfig {
  const credentials = createEnvironmentCredentialPort(environment);
  return {
    providerId: 'openai-compatible',
    model: value(environment, TUI_MODEL_ENV.model) ?? 'gpt-4o-mini',
    configured: Boolean(value(environment, TUI_MODEL_ENV.apiKey)),
    credentials,
  };
}

export function missingModelConfigurationMessage(): string {
  return [
    'No model credential configured.',
    `Set ${TUI_MODEL_ENV.apiKey}; optionally set ${TUI_MODEL_ENV.baseUrl} and ${TUI_MODEL_ENV.model}.`,
  ].join(' ');
}
