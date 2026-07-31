import type {
  ModelProviderResult,
  ModelStreamEvent,
  ModelToolCall,
  ModelUsage,
} from './model-provider-contracts.ts';

export interface OpenAIChatStreamError {
  readonly type: string;
  readonly message: string;
}

export interface OpenAIChatStreamResult extends ModelProviderResult {
  readonly streamError?: OpenAIChatStreamError;
}

export interface ConsumeOpenAIChatStreamOptions {
  readonly response: Response;
  readonly providerId: string;
  readonly signal?: AbortSignal;
  readonly idleTimeoutMs?: number;
  readonly malformedPayload?: 'throw' | 'ignore';
  readonly streamErrorMode?: 'throw' | 'return';
  readonly onEvent?: (event: ModelStreamEvent) => void;
  readonly onPayload?: (payload: string, parsed: unknown) => void;
  readonly onMalformedPayload?: (payload: string, error: unknown) => void;
  readonly onIgnoredLine?: (line: string) => void;
  readonly onDone?: () => void;
}

export class ModelProviderStreamError extends Error {
  readonly providerId: string;

  constructor(providerId: string, message: string) {
    super(`Model provider "${providerId}" stream failed: ${message}`);
    this.name = 'ModelProviderStreamError';
    this.providerId = providerId;
  }
}

type OpenAIChunk = {
  readonly choices?: readonly {
    readonly delta?: {
      readonly content?: unknown;
      readonly reasoning_content?: unknown;
      readonly reasoning?: unknown;
      readonly reasoningContent?: unknown;
      readonly thinking?: unknown;
      readonly reasoning_details?: unknown;
      readonly tool_calls?: readonly {
        readonly index?: number;
        readonly id?: string;
        readonly function?: { readonly name?: string; readonly arguments?: string };
      }[];
    };
  }[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly total_tokens?: number;
    readonly prompt_tokens_details?: { readonly cached_tokens?: number };
    readonly prompt_cache_hit_tokens?: number;
    readonly prompt_cache_hit?: number;
    readonly input_tokens_details?: { readonly cached_tokens?: number };
  } | null;
  readonly error?: {
    readonly type?: string;
    readonly code?: string;
    readonly message?: string;
  };
};

type MutableToolCall = { id: string; name: string; arguments: string };

function textLike(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    const candidate = part as Record<string, unknown>;
    return typeof candidate.text === 'string'
      ? candidate.text
      : typeof candidate.content === 'string'
        ? candidate.content
        : '';
  }).join('');
}

type OpenAIChoiceDelta = NonNullable<NonNullable<OpenAIChunk['choices']>[number]['delta']>;

function reasoningDelta(delta: OpenAIChoiceDelta | undefined): string {
  if (!delta || typeof delta !== 'object') return '';
  const value = delta as Record<string, unknown>;
  for (const key of ['reasoning_content', 'reasoning', 'reasoningContent', 'thinking']) {
    const text = textLike(value[key]);
    if (text) return text;
  }
  if (Array.isArray(value.reasoning_details)) {
    return value.reasoning_details.map((part) => {
      if (!part || typeof part !== 'object') return '';
      const record = part as Record<string, unknown>;
      return textLike(record.text ?? record.content ?? record.summary);
    }).join('');
  }
  return '';
}

function usageFrom(chunk: OpenAIChunk): ModelUsage | undefined {
  if (!chunk.usage) return undefined;
  const promptTokens = chunk.usage.prompt_tokens ?? 0;
  const cacheReadTokens = chunk.usage.prompt_tokens_details?.cached_tokens
    ?? chunk.usage.prompt_cache_hit_tokens
    ?? chunk.usage.prompt_cache_hit
    ?? chunk.usage.input_tokens_details?.cached_tokens
    ?? 0;
  return {
    inputTokens: Math.max(0, promptTokens - cacheReadTokens),
    outputTokens: chunk.usage.completion_tokens ?? 0,
    totalTokens: chunk.usage.total_tokens,
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
  };
}

function streamErrorFrom(chunk: OpenAIChunk): OpenAIChatStreamError | undefined {
  if (!chunk.error) return undefined;
  return {
    type: chunk.error.type || chunk.error.code || 'provider_stream_error',
    message: chunk.error.message || 'Provider stream failed.',
  };
}

function normalizeToolCalls(toolCalls: ReadonlyMap<number, MutableToolCall>): ModelToolCall[] {
  return [...toolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => ({ ...call }));
}

function idleTimeoutError(ms: number): Error {
  const error = new Error(`provider_stream_idle_timeout: no SSE data received for ${ms}ms`);
  error.name = 'ProviderStreamIdleTimeoutError';
  return error;
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number | undefined,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!idleTimeoutMs || !Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
    return reader.read();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(idleTimeoutError(idleTimeoutMs)), idleTimeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function consumeOpenAIChatStream(
  options: ConsumeOpenAIChatStreamOptions,
): Promise<OpenAIChatStreamResult> {
  if (!options.response.body) {
    throw new ModelProviderStreamError(options.providerId, 'response body is empty');
  }

  const reader = options.response.body.getReader();
  const decoder = new TextDecoder();
  const toolCalls = new Map<number, MutableToolCall>();
  let buffer = '';
  let content = '';
  let reasoningContent = '';
  let usage: ModelUsage | undefined;
  let streamError: OpenAIChatStreamError | undefined;
  let stopped = false;

  const abortReader = () => {
    stopped = true;
    void reader.cancel(options.signal?.reason).catch(() => {});
  };
  options.signal?.addEventListener('abort', abortReader, { once: true });

  const consumeLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (!trimmed.startsWith('data:')) {
      options.onIgnoredLine?.(trimmed);
      return;
    }
    const payload = trimmed.slice(5).trimStart();
    if (payload === '[DONE]') {
      stopped = true;
      options.onDone?.();
      return;
    }

    let chunk: OpenAIChunk;
    try {
      chunk = JSON.parse(payload) as OpenAIChunk;
    } catch (error) {
      options.onMalformedPayload?.(payload, error);
      if (options.malformedPayload !== 'ignore') {
        throw new ModelProviderStreamError(options.providerId, 'received invalid JSON');
      }
      return;
    }
    options.onPayload?.(payload, chunk);

    const error = streamErrorFrom(chunk);
    if (error) {
      streamError = error;
      stopped = true;
      if (options.streamErrorMode !== 'return') {
        throw new ModelProviderStreamError(options.providerId, error.message);
      }
      return;
    }

    const delta = chunk.choices?.[0]?.delta;
    const text = textLike(delta?.content);
    if (text) {
      content += text;
      options.onEvent?.({ type: 'text.delta', content: text });
    }
    const reasoning = reasoningDelta(delta);
    if (reasoning) {
      reasoningContent += reasoning;
      options.onEvent?.({ type: 'reasoning.delta', content: reasoning });
    }
    for (const toolDelta of delta?.tool_calls ?? []) {
      const index = toolDelta.index ?? 0;
      const call = toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
      if (toolDelta.id) call.id = toolDelta.id;
      if (toolDelta.function?.name) call.name += toolDelta.function.name;
      if (toolDelta.function?.arguments) call.arguments += toolDelta.function.arguments;
      toolCalls.set(index, call);
      options.onEvent?.({
        type: 'tool_call.delta',
        index,
        ...(toolDelta.id ? { id: toolDelta.id } : {}),
        ...(toolDelta.function?.name ? { name: toolDelta.function.name } : {}),
        ...(toolDelta.function?.arguments ? { arguments: toolDelta.function.arguments } : {}),
      });
    }
    const nextUsage = usageFrom(chunk);
    if (nextUsage) {
      usage = nextUsage;
      options.onEvent?.({ type: 'usage', usage });
    }
  };

  try {
    while (!stopped) {
      const { done, value } = await readChunk(reader, options.idleTimeoutMs);
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new Error('Model stream aborted.');
      }
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        consumeLine(line);
        if (stopped) break;
      }
      if (done) {
        if (!stopped && buffer.trim()) consumeLine(buffer);
        break;
      }
    }
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', abortReader);
    reader.releaseLock();
  }

  const completedCalls = normalizeToolCalls(toolCalls);
  for (const call of completedCalls) {
    options.onEvent?.({ type: 'tool_call.completed', call });
  }

  return {
    content,
    ...(reasoningContent ? { reasoningContent } : {}),
    toolCalls: completedCalls,
    ...(usage ? { usage } : {}),
    ...(streamError ? { streamError } : {}),
  };
}
