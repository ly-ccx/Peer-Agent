import type { ModelMessage, ModelProviderResult } from '@peer-agent/runtime-node';

interface AnthropicContinuation {
  readonly providerId: string;
  readonly model: string;
  readonly thinking: string;
  readonly signature?: string;
}

// Native provider material follows live message identity. Canonical history,
// checkpoints serialized to disk, and the renderer receive ordinary messages.
const responses = new WeakMap<ModelProviderResult, AnthropicContinuation>();
const messages = new WeakMap<ModelMessage, AnthropicContinuation>();

export function rememberAnthropicContinuation(result: ModelProviderResult, continuation: AnthropicContinuation) {
  responses.set(result, continuation);
  return result;
}

export function modelAssistantMessage(result: ModelProviderResult): ModelMessage {
  const message: ModelMessage = result.toolCalls.length
    ? { role: 'assistant', content: result.content || null, toolCalls: result.toolCalls }
    : { role: 'assistant', content: result.content };
  const continuation = responses.get(result);
  if (continuation) messages.set(message, continuation);
  return message;
}

export function readAnthropicContinuation(message: ModelMessage, providerId: string, model: string) {
  const continuation = messages.get(message);
  return continuation?.providerId === providerId && continuation.model === model ? continuation : undefined;
}
