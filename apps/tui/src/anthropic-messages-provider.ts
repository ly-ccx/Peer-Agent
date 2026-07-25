import type {
  ModelMessage,
  ModelProvider,
  ModelProviderRequest,
  ModelProviderResult,
  ModelToolCall,
  ModelToolDefinition,
  ModelUsage,
} from '@peer-agent/runtime-node';
import { ModelProviderHttpError, ModelProviderStreamError } from '@peer-agent/runtime-node';

import {
  countAnthropicRequestFromDesktop,
  sendAnthropicMessagesStreamFromDesktop,
} from './desktop-provider-adapters.ts';
import { createTuiWebContentsBridge } from './tui-web-contents-bridge.ts';

export interface CreateAnthropicMessagesProviderOptions {
  readonly providerId: string;
  readonly baseUrl?: string;
  readonly getApiKey: () => Promise<string>;
  /**
   * Optional inject for tests. Defaults to Desktop `sendAnthropicMessagesStream`
   * so TUI reuses the same anthropic-messages wire as the desktop client.
   */
  readonly sendStream?: (args: Record<string, unknown>) => Promise<AnthropicMessagesStreamResult>;
  readonly countInputTokens?: (
    args: Record<string, unknown>,
  ) => Promise<{ inputTokens: number; source: 'provider_count_api' }>;
}

export interface AnthropicMessagesStreamResult {
  readonly ok?: boolean;
  readonly textContent?: string;
  readonly content?: string;
  readonly thinkingContent?: string;
  readonly thinkingSignature?: string;
  readonly toolUseBlocks?: ReadonlyArray<{
    readonly id?: string;
    readonly name?: string;
    readonly inputJson?: string;
  }>;
  readonly stopReason?: string | null;
  readonly streamUsage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheWriteTokens?: number;
    readonly cacheReadTokens?: number;
  } | null;
  readonly streamError?: { readonly message?: string; readonly type?: string } | null;
  readonly errorText?: string;
  readonly status?: number;
  readonly providerError?: boolean;
}

function splitSystemAndMessages(messages: readonly ModelMessage[]): {
  system: string | undefined;
  messages: Array<Record<string, unknown>>;
} {
  const systemParts: string[] = [];
  const rest: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    if (message.role === 'system') {
      if (typeof message.content === 'string' && message.content.trim()) {
        systemParts.push(message.content);
      } else if (Array.isArray(message.content)) {
        const text = message.content
          .map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text?: unknown }).text ?? '') : ''))
          .filter(Boolean)
          .join('\n');
        if (text.trim()) systemParts.push(text);
      }
      continue;
    }

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
    rest.push(serialized);
  }

  const system = systemParts.length > 0 ? systemParts.join('\n\n') : undefined;
  return { system, messages: rest };
}

function toAnthropicTools(tools: readonly ModelToolDefinition[] | undefined): unknown[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool) => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    input_schema: tool.parameters ?? { type: 'object', properties: {} },
  }));
}

function usageFrom(streamUsage: AnthropicMessagesStreamResult['streamUsage']): ModelUsage | undefined {
  if (!streamUsage) return undefined;
  const inputTokens = streamUsage.inputTokens ?? 0;
  const outputTokens = streamUsage.outputTokens ?? 0;
  const usage: ModelUsage = {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
  if (
    (typeof streamUsage.cacheReadTokens === 'number' && streamUsage.cacheReadTokens > 0)
    || (typeof streamUsage.cacheWriteTokens === 'number' && streamUsage.cacheWriteTokens > 0)
  ) {
    return {
      ...usage,
      cacheReadTokens: streamUsage.cacheReadTokens ?? 0,
      cacheWriteTokens: streamUsage.cacheWriteTokens ?? 0,
    };
  }
  return usage;
}

function toolCallsFrom(
  toolUseBlocks: AnthropicMessagesStreamResult['toolUseBlocks'],
): ModelToolCall[] {
  if (!toolUseBlocks?.length) return [];
  return toolUseBlocks
    .map((block, index) => ({
      id: String(block.id || `anthropic-tool-${index}`),
      name: String(block.name || ''),
      arguments: typeof block.inputJson === 'string' ? block.inputJson : '',
    }))
    .filter((call) => call.name);
}


function effortFrom(request: ModelProviderRequest): string {
  if (!request.reasoningEffort || request.reasoningEffort === 'default') return 'default';
  return request.reasoningEffort;
}

/**
 * TUI ModelProvider that reuses Desktop's anthropic-messages wire
 * (`sendAnthropicMessagesStream` / `/v1/messages` SSE),
 * instead of token + OpenAI-compatible `/chat/completions`.
 */
export function createAnthropicMessagesProvider(
  options: CreateAnthropicMessagesProviderOptions,
): ModelProvider {
  const sendStream = options.sendStream
    ?? ((args: Record<string, unknown>) => sendAnthropicMessagesStreamFromDesktop(args) as Promise<AnthropicMessagesStreamResult>);
  const countInputTokens = options.countInputTokens ?? countAnthropicRequestFromDesktop;

  return {
    contextCountCapability: { kind: 'provider_count_api' },
    async countInputTokens(request) {
      const apiKey = await options.getApiKey();
      if (!apiKey?.trim()) return null;
      const { system, messages } = splitSystemAndMessages(request.messages);
      const effort = effortFrom(request);
      return countInputTokens({
        baseUrl: options.baseUrl,
        apiKey,
        model: request.model,
        system,
        messages,
        tools: toAnthropicTools(request.tools),
        effort,
        supportsReasoning: Boolean(effort && effort !== 'off'),
        maxOutputTokens: request.maxOutputTokens,
        signal: request.signal,
        promptCaching: true,
      });
    },
    async stream(request: ModelProviderRequest): Promise<ModelProviderResult> {
      const apiKey = await options.getApiKey();
      if (!apiKey?.trim()) {
        throw new Error('Anthropic API key is unavailable. Configure it in Desktop settings and retry.');
      }

      const { system, messages } = splitSystemAndMessages(request.messages);
      const effort = effortFrom(request);
      const supportsReasoning = Boolean(effort && effort !== 'off');
      const webContents = createTuiWebContentsBridge(request.onEvent);

      const result = await sendStream({
        baseUrl: options.baseUrl,
        apiKey,
        model: request.model,
        system,
        messages,
        tools: toAnthropicTools(request.tools),
        effort,
        supportsReasoning,
        maxOutputTokens: request.maxOutputTokens,
        signal: request.signal,
        webContents,
        streamId: `tui-anthropic-${options.providerId}`,
        // Desktop adapter will encode via encodeAnthropicMessagesRequest.
        promptCaching: true,
      });

      if (!result || result.ok === false || result.providerError) {
        const detail = String(result?.errorText || result?.streamError?.message || '').trim();
        const status = typeof result?.status === 'number' ? result.status : undefined;
        if (status && status >= 400) {
          throw new ModelProviderHttpError(options.providerId, status, detail || undefined);
        }
        throw new ModelProviderStreamError(
          options.providerId,
          detail || 'Anthropic messages stream failed.',
        );
      }

      if (result.streamError?.message) {
        throw new ModelProviderStreamError(
          options.providerId,
          result.streamError.message,
        );
      }

      const content = String(result.textContent || result.content || '');
      // Surface tool_use blocks whenever present so Runtime can execute them.
      const toolCalls = toolCallsFrom(result.toolUseBlocks);
      const usage = usageFrom(result.streamUsage);
      if (usage && request.onEvent) {
        request.onEvent({ type: 'usage', usage });
      }

      return {
        content,
        toolCalls,
        ...(usage ? { usage } : {}),
      };
    },
  };
}
