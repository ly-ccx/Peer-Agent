import type {
  ModelMessage,
  ModelProvider,
  ModelProviderRequest,
  ModelProviderResult,
  ModelStreamEvent,
  ModelToolCall,
  ModelUsage,
} from '@peer-agent/runtime-node';
import { ModelProviderHttpError, ModelProviderStreamError } from '@peer-agent/runtime-node';

import {
  GEMINI_CODE_ASSIST_BASE_URL,
  sendGeminiStreamFromDesktop,
} from './desktop-provider-adapters.ts';
import { createTuiWebContentsBridge } from './tui-web-contents-bridge.ts';

export interface GeminiStreamResult {
  readonly ok?: boolean;
  readonly status?: number;
  readonly content?: string;
  readonly thinkingContent?: string;
  readonly toolCalls?: Array<{
    id?: string;
    name?: string;
    arguments?: string;
    function?: { name?: string; arguments?: string };
  }>;
  readonly streamUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  } | null;
  readonly streamError?: { message?: string } | null;
  readonly providerError?: unknown;
  readonly errorText?: string;
}

export interface CreateGeminiProviderOptions {
  readonly providerId: string;
  /** Base URL; OAuth defaults to Code Assist host, not generativelanguage openai shim. */
  readonly baseUrl?: string;
  readonly authMethod: 'api_key' | 'oauth_google' | string;
  readonly getApiKey: () => Promise<string>;
  readonly getProjectId?: () => Promise<string | null | undefined>;
  readonly sendStream?: (args: Record<string, unknown>) => Promise<GeminiStreamResult>;
}

function usageFrom(streamUsage: GeminiStreamResult['streamUsage']): ModelUsage | undefined {
  if (!streamUsage) return undefined;
  const inputTokens = Number(streamUsage.inputTokens || 0);
  const outputTokens = Number(streamUsage.outputTokens || 0);
  const usage: ModelUsage = {
    inputTokens,
    outputTokens,
    totalTokens: Number(streamUsage.totalTokens || inputTokens + outputTokens),
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

function toolCallsFrom(raw: GeminiStreamResult['toolCalls']): ModelToolCall[] {
  if (!raw?.length) return [];
  return raw
    .map((call, index) => {
      const name = String(call.name || call.function?.name || '');
      const args = String(call.arguments || call.function?.arguments || '');
      return {
        id: String(call.id || `gemini-tool-${index}`),
        name,
        arguments: args,
      };
    })
    .filter((call) => call.name);
}

function toDesktopMessages(messages: readonly ModelMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => {
    const base: Record<string, unknown> = {
      role: message.role,
      content: message.content,
    };
    if (message.name) base.name = message.name;
    if (message.toolCallId) base.tool_call_id = message.toolCallId;
    if (message.toolCalls?.length) {
      base.tool_calls = message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.name,
          arguments: call.arguments,
        },
      }));
    }
    return base;
  });
}

function toDesktopTools(tools: ModelProviderRequest['tools']): Array<Record<string, unknown>> | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function resolveBaseUrl(options: CreateGeminiProviderOptions): string {
  if (options.baseUrl?.trim()) return options.baseUrl.trim().replace(/\/+$/, '');
  if (options.authMethod === 'oauth_google') return GEMINI_CODE_ASSIST_BASE_URL;
  return 'https://generativelanguage.googleapis.com/v1beta';
}

async function defaultSendStream(args: Record<string, unknown>): Promise<GeminiStreamResult> {
  return sendGeminiStreamFromDesktop(args) as Promise<GeminiStreamResult>;
}

/**
 * TUI ModelProvider for Desktop's Gemini wire (`sendGeminiStream` /
 * generateContent SSE). Does NOT rewrite baseUrl to `.../v1beta/openai`.
 */
export function createGeminiProvider(options: CreateGeminiProviderOptions): ModelProvider {
  const sendStream = options.sendStream ?? defaultSendStream;

  return {
    async stream(request: ModelProviderRequest): Promise<ModelProviderResult> {
      const apiKey = await options.getApiKey();
      if (!apiKey?.trim()) {
        throw new Error(
          options.authMethod === 'oauth_google'
            ? 'Google OAuth access token is unavailable. Sign in via Desktop or unlock Keychain and retry.'
            : 'Gemini API key is unavailable. Configure it in Desktop settings and retry.',
        );
      }

      const projectId = options.getProjectId ? await options.getProjectId() : null;
      const webContents = createTuiWebContentsBridge(request.onEvent);
      const baseUrl = resolveBaseUrl(options);

      const result = await sendStream({
        baseUrl,
        apiKey,
        model: request.model,
        messages: toDesktopMessages(request.messages),
        tools: toDesktopTools(request.tools),
        effort: request.reasoningEffort || 'default',
        supportsReasoning: Boolean(request.reasoningEffort && request.reasoningEffort !== 'off'),
        maxOutputTokens: request.maxOutputTokens,
        projectId: projectId || undefined,
        authMethod: options.authMethod,
        signal: request.signal,
        webContents,
        streamId: `tui-gemini-${options.providerId}`,
      });

      if (!result || result.ok === false || result.providerError) {
        const detail = String(result?.errorText || result?.streamError?.message || '').trim();
        const status = typeof result?.status === 'number' ? result.status : undefined;
        if (status && status >= 400) {
          throw new ModelProviderHttpError(options.providerId, status, detail || undefined);
        }
        throw new ModelProviderStreamError(
          options.providerId,
          detail || 'Gemini stream failed.',
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
      if (thinkingContent && request.onEvent) {
        request.onEvent({ type: 'reasoning.delta', content: thinkingContent });
      }

      const toolCalls = toolCallsFrom(result.toolCalls);
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
