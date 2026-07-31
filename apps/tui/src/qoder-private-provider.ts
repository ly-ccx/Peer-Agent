import type {
  ModelMessage,
  ModelProvider,
  ModelProviderRequest,
  ModelProviderResult,
  ModelToolCall,
  ModelUsage,
} from '@peer-agent/runtime-node';
import { ModelProviderHttpError, ModelProviderStreamError } from '@peer-agent/runtime-node';

import { sendQoderPrivateStreamFromDesktop } from './desktop-provider-adapters.ts';
import { createTuiWebContentsBridge } from './tui-web-contents-bridge.ts';

export interface CreateQoderPrivateProviderOptions {
  readonly providerId: string;
  readonly baseUrl?: string;
  readonly getAccessToken: () => Promise<string>;
  /**
   * Optional inject for tests. Defaults to Desktop `sendQoderPrivateStream`
   * so TUI reuses the same qoder-private wire as the desktop client.
   */
  readonly sendStream?: (args: Record<string, unknown>) => Promise<QoderPrivateStreamResult>;
}

export interface QoderPrivateStreamResult {
  readonly ok?: boolean;
  readonly content?: string;
  readonly thinkingContent?: string;
  readonly toolCalls?: ReadonlyArray<{
    readonly id?: string;
    readonly name?: string;
    readonly arguments?: string;
  }>;
  readonly streamUsage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
    readonly cacheReadTokens?: number;
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly total_tokens?: number;
  } | null;
  readonly streamError?: { readonly message?: string; readonly type?: string } | null;
  readonly errorText?: string;
  readonly status?: number;
  readonly providerError?: boolean;
}

function serializeMessage(message: ModelMessage): Record<string, unknown> {
  const serialized: Record<string, unknown> = {
    role: message.role,
    content: message.content,
  };
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

function serializeTools(request: ModelProviderRequest): unknown[] | undefined {
  if (!request.tools?.length) return undefined;
  return request.tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    },
  }));
}

function usageFrom(streamUsage: QoderPrivateStreamResult['streamUsage']): ModelUsage | undefined {
  if (!streamUsage) return undefined;
  const inputTokens =
    streamUsage.inputTokens
    ?? streamUsage.prompt_tokens
    ?? 0;
  const outputTokens =
    streamUsage.outputTokens
    ?? streamUsage.completion_tokens
    ?? 0;
  const totalTokens =
    streamUsage.totalTokens
    ?? streamUsage.total_tokens
    ?? inputTokens + outputTokens;
  const usage: ModelUsage = {
    inputTokens,
    outputTokens,
    totalTokens,
  };
  if (typeof streamUsage.cacheReadTokens === 'number' && streamUsage.cacheReadTokens > 0) {
    return {
      ...usage,
      cacheReadTokens: streamUsage.cacheReadTokens,
      // 缓存写：Qoder 上游无 cache write 数据，留空（区别于「真 0」）。
    };
  }
  return usage;
}

function toolCallsFrom(
  toolCalls: QoderPrivateStreamResult['toolCalls'],
): ModelToolCall[] {
  if (!toolCalls?.length) return [];
  return toolCalls
    .map((call, index) => ({
      id: String(call.id || `qoder-tool-${index}`),
      name: String(call.name || ''),
      arguments: typeof call.arguments === 'string' ? call.arguments : '',
    }))
    .filter((call) => call.name);
}


function modelOptionValuesFrom(request: ModelProviderRequest): Record<string, unknown> {
  if (!request.reasoningEffort || request.reasoningEffort === 'default') {
    return {};
  }
  // Qoder private projection accepts model option values; reasoning maps through
  // Desktop resolveQoderModelOptionProjection when the model advertises it.
  return { reasoning: request.reasoningEffort };
}

/**
 * TUI ModelProvider that reuses Desktop's qoder-private wire
 * (`sendQoderPrivateStream` / prepareQoderInferRequest / private SSE),
 * instead of token + OpenAI-compatible `/chat/completions`.
 */
export function createQoderPrivateProvider(
  options: CreateQoderPrivateProviderOptions,
): ModelProvider {
  const sendStream = options.sendStream
    ?? ((args: Record<string, unknown>) => sendQoderPrivateStreamFromDesktop(args) as Promise<QoderPrivateStreamResult>);

  return {
    contextCountCapability: { kind: 'observed_usage_only' },
    async stream(request: ModelProviderRequest): Promise<ModelProviderResult> {
      const apiKey = await options.getAccessToken();
      if (!apiKey?.trim()) {
        throw new Error(
          'Qoder local auth is not available. Open the Qoder app and sign in, then retry.',
        );
      }

      const webContents = createTuiWebContentsBridge(request.onEvent);
      const result = await sendStream({
        baseUrl: options.baseUrl,
        apiKey,
        model: request.model,
        messages: request.messages.map(serializeMessage),
        tools: serializeTools(request),
        maxOutputTokens: request.maxOutputTokens,
        signal: request.signal,
        webContents,
        streamId: `tui-qoder-${options.providerId}`,
        // Live deltas go through the webContents bridge above.
        bufferThinkingDeltas: false,
        emitBufferedThinkingDeltas: true,
        modelOptionValues: modelOptionValuesFrom(request),
      });

      if (!result || result.ok === false || result.providerError) {
        const detail = String(result?.errorText || result?.streamError?.message || '').trim();
        const status = typeof result?.status === 'number' ? result.status : undefined;
        if (status && status >= 400) {
          throw new ModelProviderHttpError(options.providerId, status, detail || undefined);
        }
        throw new ModelProviderStreamError(
          options.providerId,
          detail || 'Qoder private stream failed.',
        );
      }

      if (result.streamError?.message) {
        throw new ModelProviderStreamError(
          options.providerId,
          result.streamError.message,
        );
      }

      const content = String(result.content || '');
      const thinkingContent = String(result.thinkingContent || '');
      // If the adapter buffered thinking and never emitted via webContents,
      // surface the final thinking blob once for TUI consumers.
      if (thinkingContent && request.onEvent) {
        // Only emit when nothing was streamed live is hard to know; provider-chat-model
        // accumulates reasoning.delta. Avoid double-emit by not replaying final thinking.
      }

      const usage = usageFrom(result.streamUsage);
      if (usage && request.onEvent) {
        request.onEvent({ type: 'usage', usage });
      }

      return {
        content,
        toolCalls: toolCallsFrom(result.toolCalls),
        ...(usage ? { usage } : {}),
      };
    },
  };
}
