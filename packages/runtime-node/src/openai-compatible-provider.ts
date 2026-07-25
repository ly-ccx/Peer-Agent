import type {
  ModelMessage,
  ModelProvider,
  ModelProviderRequest,
  OpenAICompatibleProviderConfig,
} from './model-provider-contracts.ts';
import {
  consumeOpenAIChatStream,
  ModelProviderStreamError,
} from './openai-chat-stream.ts';

export interface CreateOpenAICompatibleProviderOptions {
  readonly config: OpenAICompatibleProviderConfig;
  readonly fetch?: typeof globalThis.fetch;
}

export class ModelProviderHttpError extends Error {
  readonly status: number;
  readonly providerId: string;

  constructor(providerId: string, status: number, detail?: string) {
    super(`Model provider "${providerId}" returned HTTP ${status}${detail ? `: ${detail}` : '.'}`);
    this.name = 'ModelProviderHttpError';
    this.providerId = providerId;
    this.status = status;
  }
}

export { ModelProviderStreamError } from './openai-chat-stream.ts';

function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

function serializeMessage(message: ModelMessage): Record<string, unknown> {
  const serialized: Record<string, unknown> = { role: message.role, content: message.content };
  if (message.name) serialized.name = message.name;
  if (message.toolCallId) serialized.tool_call_id = message.toolCallId;
  if (message.toolCalls) {
    serialized.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    }));
  }
  return serialized;
}

async function errorDetail(response: Response): Promise<string | undefined> {
  try {
    const value = await response.json() as { error?: { message?: unknown } };
    return typeof value.error?.message === 'string' ? value.error.message : undefined;
  } catch {
    return undefined;
  }
}

export function createOpenAICompatibleProvider(
  options: CreateOpenAICompatibleProviderOptions,
): ModelProvider {
  const fetchImplementation = options.fetch ?? globalThis.fetch;

  return {
    contextCountCapability: { kind: 'observed_usage_only' },
    async stream(request) {
      const response = await fetchImplementation(endpoint(options.config.baseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${options.config.apiKey}`,
          ...(options.config.organizationId ? { 'OpenAI-Organization': options.config.organizationId } : {}),
          ...options.config.headers,
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages.map(serializeMessage),
          stream: true,
          stream_options: { include_usage: true },
          ...(request.tools?.length ? {
            tools: request.tools.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                ...(tool.description ? { description: tool.description } : {}),
                parameters: tool.parameters ?? { type: 'object', properties: {} },
              },
            })),
          } : {}),
          ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
          ...(request.maxOutputTokens === undefined ? {} : { max_tokens: request.maxOutputTokens }),
          ...(!request.reasoningEffort || request.reasoningEffort === 'default'
            ? {}
            : { reasoning_effort: request.reasoningEffort }),
        }),
        signal: request.signal,
      });

      if (!response.ok) {
        throw new ModelProviderHttpError(
          options.config.providerId,
          response.status,
          await errorDetail(response),
        );
      }

      return consumeOpenAIChatStream({
        response,
        providerId: options.config.providerId,
        signal: request.signal,
        onEvent: request.onEvent,
      });
    },
  };
}
