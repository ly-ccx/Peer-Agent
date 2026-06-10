import {
  normalizeAnthropicMessages,
  normalizeOpenAIMessages,
} from './message-normalizer.mjs';

const OPENAI_REASONING_EFFORT = { low: 'low', default: 'medium', high: 'high' };
const ANTHROPIC_THINKING_BUDGET = { low: 4096, default: 10240, high: 32768 };

export function encodeOpenAIChatRequest({
  model,
  messages,
  tools,
  effort = 'default',
}) {
  const body = {
    model,
    messages: normalizeOpenAIMessages(messages),
    stream: true,
    stream_options: { include_usage: true },
    tools,
  };
  if (effort && effort !== 'default') {
    body.reasoning_effort = OPENAI_REASONING_EFFORT[effort] ?? 'medium';
  }
  return body;
}

export function encodeAnthropicMessagesRequest({
  model,
  system,
  messages,
  tools,
  effort = 'default',
}) {
  const body = {
    model,
    system,
    messages: normalizeAnthropicMessages(messages),
    max_tokens: 16384,
    stream: true,
    tools,
  };
  if (effort === 'high') {
    body.thinking = {
      type: 'enabled',
      budget_tokens: ANTHROPIC_THINKING_BUDGET.high,
    };
  }
  return body;
}
