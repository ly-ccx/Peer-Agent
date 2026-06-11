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
 * 在一条 message 的最后一个 content block 上打 ephemeral cache_control 断点。
 * content 可能是字符串或数组；统一成数组才能在末块打断点。返回是否成功打上。
 */
function markMessageCacheBreakpoint(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (typeof msg.content === 'string' && msg.content.trim()) {
    msg.content = [{ type: 'text', text: msg.content, cache_control: EPHEMERAL }];
    return true;
  }
  if (Array.isArray(msg.content) && msg.content.length) {
    const lastBlock = msg.content[msg.content.length - 1];
    if (lastBlock && typeof lastBlock === 'object') {
      lastBlock.cache_control = EPHEMERAL;
      return true;
    }
  }
  return false;
}

/**
 * Prompt caching (ADR 24): 在请求体的稳定前缀上打 ephemeral cache_control 断点，
 * 让 Anthropic 缓存「system + 历史」前缀，下一轮命中以降低输入计费、提升命中率。
 *
 * 两个断点：
 *  1. system —— 最大且最稳定的前缀，字符串转为带 cache_control 的 text block 数组。
 *  2. 历史前缀 —— 断点打在【倒数第二条消息】（即上一轮的结尾），而不是每轮都变的
 *     最后一条。这样下一轮请求的断点位置正好匹配上一轮已缓存的前缀边界，命中
 *     cache_read；本轮新输入留在断点之后，不破坏前缀。
 *
 *     若断点打在每轮变化的最后一条上，则每轮只写新缓存、永远读不到旧缓存
 *     （cacheWrite 一直涨、cacheRead 恒为 0），是最差组合（既交写入溢价又拿不到读取折扣）。
 *
 * 纯函数：只读 body 的字段、原地打好断点并返回，便于单测。
 */
export function applyAnthropicCacheControl(body) {
  // 1. system 断点。
  if (typeof body.system === 'string' && body.system.trim()) {
    body.system = [{ type: 'text', text: body.system, cache_control: EPHEMERAL }];
  } else if (Array.isArray(body.system) && body.system.length) {
    const last = body.system[body.system.length - 1];
    if (last && typeof last === 'object') last.cache_control = EPHEMERAL;
  }

  // 2. 历史前缀断点：打在倒数第二条消息（稳定前缀边界），而非每轮都变的最后一条。
  //    仅一条消息（首轮）时无稳定历史前缀可缓存，跳过，仅靠 system 缓存。
  const msgs = body.messages;
  if (Array.isArray(msgs) && msgs.length >= 2) {
    markMessageCacheBreakpoint(msgs[msgs.length - 2]);
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
