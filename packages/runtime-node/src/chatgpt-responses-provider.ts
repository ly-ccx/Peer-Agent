import type {
  ModelMessage,
  ModelProvider,
  ModelProviderRequest,
  ModelProviderResult,
  ModelStreamEvent,
  ModelToolCall,
  ModelUsage,
} from './model-provider-contracts.ts';
import { ModelProviderHttpError, ModelProviderStreamError } from './openai-compatible-provider.ts';
import type { ChatGptOAuthTokens } from './shared-model-config.ts';

export interface CreateChatGptResponsesProviderOptions {
  readonly baseUrl: string;
  readonly tokens?: ChatGptOAuthTokens;
  readonly resolveTokens?: () => ChatGptOAuthTokens;
  readonly fetch?: typeof globalThis.fetch;
  readonly refreshTokens?: (tokens: ChatGptOAuthTokens) => Promise<ChatGptOAuthTokens>;
  readonly persistTokens?: (tokens: ChatGptOAuthTokens) => void;
  /**
   * Optional channel-specific request headers (e.g. Grok client identity).
   * Merged after the built-in Responses headers so callers can override
   * non-auth fields when a channel requires a distinct surface/version.
   */
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

function contentText(content: ModelMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!content) return '';
  return content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

// Responses API requires function/tool names to match ^[a-zA-Z0-9_-]+$.
// Historical sessions may still store dotted capability ids (e.g. local.file.read).
// Execution pairing depends on call_id, so wire-side normalization is safe.
function normalizeFunctionName(value: string | undefined): string {
  const normalized = String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  return normalized || 'tool';
}

function messageInput(message: ModelMessage): Record<string, unknown>[] {
  if (message.role === 'tool') {
    return [{ type: 'function_call_output', call_id: message.toolCallId, output: contentText(message.content) }];
  }
  const items: Record<string, unknown>[] = [];
  if (message.role === 'assistant' && message.toolCalls) {
    for (const call of message.toolCalls) {
      items.push({
        type: 'function_call',
        call_id: call.id,
        name: normalizeFunctionName(call.name),
        arguments: call.arguments,
      });
    }
  }
  if (message.content) {
    type ResponsesContentPart =
      | { type: 'output_text' | 'input_text'; text: string }
      | { type: 'input_image'; image_url: string };
    const parts: ResponsesContentPart[] = Array.isArray(message.content)
      ? message.content.flatMap((part): ResponsesContentPart[] => {
          if (part.type === 'text') {
            return [{
              type: message.role === 'assistant' ? 'output_text' : 'input_text',
              text: part.text,
            }];
          }
          if (part.type === 'image_url' && message.role !== 'assistant') {
            return [{ type: 'input_image', image_url: part.image_url.url }];
          }
          return [];
        })
      : [{
          type: message.role === 'assistant' ? 'output_text' : 'input_text',
          text: typeof message.content === 'string' ? message.content : '',
        }];
    if (parts.length > 0) {
      items.unshift({
        role: message.role,
        content: parts,
      });
    }
  }
  return items;
}

function requestBody(request: ModelProviderRequest): Record<string, unknown> {
  const system = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => contentText(message.content))
    .filter(Boolean)
    .join('\n\n');
  const input = request.messages.filter((message) => message.role !== 'system').flatMap(messageInput);
  return {
    model: request.model,
    ...(system ? { instructions: system } : {}),
    input,
    tools: (request.tools ?? []).map((tool) => ({
      type: 'function',
      name: normalizeFunctionName(tool.name),
      description: tool.description,
      parameters: tool.parameters ?? {},
    })),
    tool_choice: 'auto',
    parallel_tool_calls: true,
    ...(!request.reasoningEffort || request.reasoningEffort === 'default'
      ? {}
      : { reasoning: { effort: request.reasoningEffort } }),
    stream: true,
    store: false,
  };
}

function cachedTokenCount(details: unknown): number | undefined {
  if (!details || typeof details !== 'object') return undefined;
  const value = Number((details as Record<string, unknown>).cached_tokens);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function extractCachedInputTokens(usage: Record<string, unknown>): number {
  // Align Desktop openai-responses-adapter: each details object is independent.
  // `input_tokens_details ?? prompt_tokens_details` would swallow a real hit when
  // the first object exists but has no cached_tokens (Grok often sends an empty
  // input_tokens_details alongside prompt_tokens_details.cached_tokens).
  return Number(
    cachedTokenCount(usage.input_tokens_details)
    ?? cachedTokenCount(usage.prompt_tokens_details)
    ?? usage.prompt_cache_hit_tokens
    ?? usage.prompt_cache_hit
    ?? 0,
  );
}

function usageOf(value: unknown): ModelUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const usage = value as Record<string, unknown>;
  // Responses API 的 input_tokens 已包含缓存命中；内部账本字段必须互斥，
  // 否则 context meter 做 input + cacheRead 累加会 double count。
  // 与 openai-chat-stream.usageFrom / Desktop openai-responses-adapter 保持同口径。
  const rawInputTokens = Number(usage.input_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? 0);
  const cacheReadTokens = extractCachedInputTokens(usage);
  return {
    inputTokens: Math.max(0, rawInputTokens - cacheReadTokens),
    outputTokens,
    totalTokens: rawInputTokens + outputTokens,
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
  };
}

async function consumeResponsesStream(response: Response, request: ModelProviderRequest): Promise<ModelProviderResult> {
  if (!response.body) throw new ModelProviderStreamError('chatgpt-subscription', 'ChatGPT Responses stream has no body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoningContent = '';
  let usage: ModelUsage | undefined;
  const toolCalls = new Map<string, ModelToolCall>();

  const consume = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let event: Record<string, any>;
    try { event = JSON.parse(data); } catch { throw new ModelProviderStreamError('chatgpt-subscription', 'ChatGPT Responses stream returned invalid JSON.'); }
    switch (event.type) {
      case 'response.output_text.delta':
        content += event.delta ?? '';
        request.onEvent?.({ type: 'text.delta', content: event.delta ?? '' });
        break;
      case 'response.reasoning_summary_text.delta':
        reasoningContent += event.delta ?? '';
        request.onEvent?.({ type: 'reasoning.delta', content: event.delta ?? '' });
        break;
      case 'response.output_item.added':
      case 'response.output_item.done': {
        const item = event.item;
        if (item?.type !== 'function_call' || !item.name) break;
        const call: ModelToolCall = {
          id: item.call_id ?? item.id,
          name: item.name,
          arguments: item.arguments || '{}',
        };
        toolCalls.set(call.id, call);
        if (event.type === 'response.output_item.done') request.onEvent?.({ type: 'tool_call.completed', call });
        break;
      }
      case 'response.completed':
        usage = usageOf(event.response?.usage);
        if (usage) request.onEvent?.({ type: 'usage', usage });
        break;
      case 'error':
      case 'response.failed':
        throw new ModelProviderStreamError('chatgpt-subscription', event.error?.message ?? event.response?.error?.message ?? 'ChatGPT Responses stream failed.');
      default:
        break;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n');
    while (boundary >= 0) {
      consume(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 1);
      boundary = buffer.indexOf('\n');
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) consume(buffer);
  return { content, ...(reasoningContent ? { reasoningContent } : {}), toolCalls: [...toolCalls.values()], ...(usage ? { usage } : {}) };
}

export function createChatGptResponsesProvider(options: CreateChatGptResponsesProviderOptions): ModelProvider {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  let tokens = options.tokens;
  return {
    contextCountCapability: { kind: 'observed_usage_only' },
    async stream(request) {
      tokens ??= options.resolveTokens?.();
      if (!tokens?.access) throw new Error('desktop_model_credential_unavailable');
      if (tokens.expires && tokens.expires <= Date.now() + 60_000 && options.refreshTokens) {
        tokens = await options.refreshTokens(tokens);
        options.persistTokens?.(tokens);
      }
      const response = await fetchImpl(`${options.baseUrl.replace(/\/+$/, '')}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          Authorization: `Bearer ${tokens.access}`,
          ...(tokens.accountId ? { 'chatgpt-account-id': tokens.accountId } : {}),
          'OpenAI-Beta': 'responses=experimental',
          originator: 'peer-agent',
          ...(options.extraHeaders ?? {}),
        },
        body: JSON.stringify(requestBody(request)),
        signal: request.signal,
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new ModelProviderHttpError('openai', response.status, detail);
      }
      return consumeResponsesStream(response, request);
    },
  };
}
