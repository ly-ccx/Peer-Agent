import { readProviderHttpError, safeProviderErrorLabel } from './provider-http-error.mjs';
import { stripOpenAIMessageName } from './provider-encoders/request-encoder.mjs';
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
  readonly trustGatewayErrors?: boolean;
}

export class ModelProviderHttpError extends Error {
  readonly status: number;
  readonly providerId: string;

  readonly diagnostic: Readonly<Record<string, unknown>>;

  constructor(providerId: string, status: number, detail?: string, diagnostic?: Readonly<Record<string, unknown>>) {
    detail = safeProviderErrorLabel(diagnostic?.code ?? detail, diagnostic?.actual, diagnostic?.limit);
    const upstream = Number.isInteger(diagnostic?.upstreamStatus) && Number(diagnostic?.upstreamStatus) >= 100 && Number(diagnostic?.upstreamStatus) <= 599 ? ` (upstream HTTP ${diagnostic!.upstreamStatus})` : '';
    const requestId = typeof diagnostic?.requestId === 'string' && /^(?:[a-f0-9-]{8,64}|req_[a-zA-Z0-9]{1,64})$/.test(diagnostic.requestId) ? ` [request_id=${diagnostic.requestId}]` : '';
    super(`Model provider "${providerId}" returned HTTP ${status}${upstream}${detail ? `: ${detail}` : '.'}${requestId}`);
    this.name = 'ModelProviderHttpError';
    this.providerId = providerId;
    this.status = status;
    this.diagnostic = diagnostic ?? { status, source: 'provider', code: 'http_error' };
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
  return stripOpenAIMessageName(serialized);
}

/** The identical serialization is consumed by preflight and network send. */
export function encodeOpenAICompatibleRequest(request: ModelProviderRequest): string {
  return JSON.stringify({
    model: request.model,
    messages: request.messages.map(serializeMessage),
    stream: true,
    stream_options: { include_usage: true },
    ...(request.tools?.length ? { tools: request.tools.map((tool) => ({ type: 'function', function: {
      name: tool.name, ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    } })) } : {}),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.maxOutputTokens === undefined ? {} : { max_tokens: request.maxOutputTokens }),
    ...(!request.reasoningEffort || request.reasoningEffort === 'default' ? {} : { reasoning_effort: request.reasoningEffort }),
  });
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
        body: encodeOpenAICompatibleRequest(request),
        signal: request.signal,
      });

      if (!response.ok) {
        const { detail, diagnostic } = await readProviderHttpError(response, {
          signal: request.signal, secrets: [options.config.apiKey], trustGatewayErrors: options.trustGatewayErrors,
        });
        throw new ModelProviderHttpError(options.config.providerId, response.status, detail, diagnostic);
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
