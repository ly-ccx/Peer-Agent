export type ModelMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ModelMessage {
  readonly role: ModelMessageRole;
  readonly content: string | null;
  readonly name?: string;
  readonly toolCallId?: string;
  readonly toolCalls?: readonly ModelToolCall[];
}

export interface ModelToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
}

export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface ModelUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

export type ModelStreamEvent =
  | { readonly type: 'text.delta'; readonly content: string }
  | { readonly type: 'reasoning.delta'; readonly content: string }
  | { readonly type: 'tool_call.delta'; readonly index: number; readonly id?: string; readonly name?: string; readonly arguments?: string }
  | { readonly type: 'tool_call.completed'; readonly call: ModelToolCall }
  | { readonly type: 'usage'; readonly usage: ModelUsage };

export interface ModelProviderRequest {
  readonly model: string;
  readonly messages: readonly ModelMessage[];
  readonly tools?: readonly ModelToolDefinition[];
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: ModelStreamEvent) => void;
}

export interface ModelProviderResult {
  readonly content: string;
  readonly reasoningContent?: string;
  readonly toolCalls: readonly ModelToolCall[];
  readonly usage?: ModelUsage;
}

export interface ModelProvider {
  stream(request: ModelProviderRequest): Promise<ModelProviderResult>;
}

export interface ModelCredentialRequest {
  readonly providerId: string;
  readonly profileId?: string;
}

export interface ModelCredential {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly organizationId?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface ModelCredentialPort {
  resolve(request: ModelCredentialRequest): Promise<ModelCredential | null>;
}

export interface OpenAICompatibleProviderConfig {
  readonly providerId: string;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly organizationId?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export class ModelCredentialNotFoundError extends Error {
  readonly providerId: string;

  constructor(providerId: string) {
    super(`No credential is configured for model provider "${providerId}".`);
    this.name = 'ModelCredentialNotFoundError';
    this.providerId = providerId;
  }
}

export async function resolveOpenAICompatibleProviderConfig(options: {
  readonly providerId: string;
  readonly credentials: ModelCredentialPort;
  readonly profileId?: string;
  readonly defaultBaseUrl?: string;
}): Promise<OpenAICompatibleProviderConfig> {
  const credential = await options.credentials.resolve({
    providerId: options.providerId,
    profileId: options.profileId,
  });
  if (!credential?.apiKey.trim()) {
    throw new ModelCredentialNotFoundError(options.providerId);
  }

  return {
    providerId: options.providerId,
    apiKey: credential.apiKey,
    baseUrl: credential.baseUrl?.trim() || options.defaultBaseUrl || 'https://api.openai.com/v1',
    organizationId: credential.organizationId,
    headers: credential.headers,
  };
}
