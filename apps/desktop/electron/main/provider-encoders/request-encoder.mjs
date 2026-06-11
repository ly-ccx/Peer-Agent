import {
  normalizeAnthropicMessages,
  normalizeOpenAIMessages,
} from './message-normalizer.mjs';

const OPENAI_REASONING_EFFORT = { low: 'low', default: 'medium', high: 'high' };
const ANTHROPIC_THINKING_BUDGET = { low: 4096, default: 10240, high: 32768 };
// Anthropic 约束: max_tokens 必须 > thinking.budget_tokens。
// max_tokens 是 (思考 token + 回复 token) 的总额，因此开启 thinking 时
// 需要在 budget 之上额外预留回复预算，否则 API 返回 400 导致请求必挂。
const ANTHROPIC_REPLY_TOKENS = 16384;

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

const EPHEMERAL = { type: 'ephemeral' };

/**
 * Prompt caching (ADR 24): 在请求体的稳定前缀上打 ephemeral cache_control 断点，
 * 让 Anthropic 缓存「system + 历史」前缀，下一轮命中以降低输入计费、提升命中率。
 *
 * 两个断点：
 *  1. system —— 最大且最稳定的前缀，字符串转为带 cache_control 的 text block 数组。
 *  2. 最后一条消息的最后一个 content block —— 缓存「到目前为止的全部历史」前缀，
 *     使下一轮请求的历史前缀命中缓存。
 *
 * 纯函数：只读 body 的字段、返回打好断点的新结构，不产生副作用，便于单测。
 */
export function applyAnthropicCacheControl(body) {
  // 1. system 断点。
  if (typeof body.system === 'string' && body.system.trim()) {
    body.system = [{ type: 'text', text: body.system, cache_control: EPHEMERAL }];
  } else if (Array.isArray(body.system) && body.system.length) {
    const last = body.system[body.system.length - 1];
    if (last && typeof last === 'object') last.cache_control = EPHEMERAL;
  }

  // 2. 最后一条消息断点（缓存历史前缀）。
  const msgs = body.messages;
  if (Array.isArray(msgs) && msgs.length) {
    const lastMsg = msgs[msgs.length - 1];
    if (lastMsg && typeof lastMsg === 'object') {
      // content 可能是字符串或数组；统一成数组才能在末块打断点。
      if (typeof lastMsg.content === 'string' && lastMsg.content.trim()) {
        lastMsg.content = [
          { type: 'text', text: lastMsg.content, cache_control: EPHEMERAL },
        ];
      } else if (Array.isArray(lastMsg.content) && lastMsg.content.length) {
        const lastBlock = lastMsg.content[lastMsg.content.length - 1];
        if (lastBlock && typeof lastBlock === 'object') {
          lastBlock.cache_control = EPHEMERAL;
        }
      }
    }
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
    const budgetTokens = ANTHROPIC_THINKING_BUDGET.high;
    body.thinking = {
      type: 'enabled',
      budget_tokens: budgetTokens,
    };
    // max_tokens 必须严格大于 budget_tokens，并额外预留回复 token。
    body.max_tokens = budgetTokens + ANTHROPIC_REPLY_TOKENS;
  }
  return applyAnthropicCacheControl(body);
}
