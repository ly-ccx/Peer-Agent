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
  supportsReasoning = false,
}) {
  const body = {
    model,
    messages: normalizeOpenAIMessages(messages),
    stream: true,
    stream_options: { include_usage: true },
    tools,
  };
  if (supportsReasoning && effort && effort !== 'default') {
    body.reasoning_effort = OPENAI_REASONING_EFFORT[effort] ?? 'medium';
  }
  return body;
}

const EPHEMERAL = { type: 'ephemeral' };

function isCacheableTextBlock(block) {
  return (
    block &&
    typeof block === 'object' &&
    block.type === 'text' &&
    typeof block.text === 'string' &&
    block.text.trim()
  );
}

/**
 * 在一条 message 的 text content block 上打 ephemeral cache_control 断点。
 * 不在 tool_use / tool_result / image 这类契约块上打断点，避免 provider 网关在
 * 工具续跑序列里把执行契约块误当成缓存边界。
 */
function markMessageCacheBreakpoint(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (typeof msg.content === 'string' && msg.content.trim()) {
    msg.content = [{ type: 'text', text: msg.content, cache_control: EPHEMERAL }];
    return true;
  }
  if (Array.isArray(msg.content) && msg.content.length) {
    for (let i = msg.content.length - 1; i >= 0; i--) {
      const block = msg.content[i];
      if (isCacheableTextBlock(block)) {
        block.cache_control = EPHEMERAL;
        return true;
      }
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
 *  2. 历史前缀 —— 从【倒数第二条消息】向前寻找最近的 text block，而不是每轮都变的
 *     最后一条。这样下一轮请求的断点位置正好匹配上一轮已缓存的稳定文本前缀，
 *     命中 cache_read；本轮新输入留在断点之后，不破坏前缀。
 *
 *     若断点打在每轮变化的最后一条上，则每轮只写新缓存、永远读不到旧缓存
 *     （cacheWrite 一直涨、cacheRead 恒为 0），是最差组合（既交写入溢价又拿不到读取折扣）。
 *
 *     若断点打在 tool_use / tool_result 上，则缓存边界会穿过执行契约块。在 Anthropic
 *     兼容网关下这类形状可能导致工具结果后的下一轮空结束，因此只允许 text block
 *     承载 cache_control。
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

  // 2. 历史前缀断点：从倒数第二条向前找最近 text block（稳定前缀边界），
  //    而非每轮都变的最后一条，也不落到 tool_use / tool_result 契约块。
  //    仅一条消息（首轮）时无稳定历史前缀可缓存，跳过，仅靠 system 缓存。
  const msgs = body.messages;
  if (Array.isArray(msgs) && msgs.length >= 2) {
    for (let i = msgs.length - 2; i >= 0; i--) {
      if (markMessageCacheBreakpoint(msgs[i])) break;
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
  supportsReasoning = false,
  reasoningFormat = 'enabled',
}) {
  const body = {
    model,
    system,
    messages: normalizeAnthropicMessages(messages),
    max_tokens: 16384,
    stream: true,
    tools,
  };
  if (supportsReasoning && effort === 'high') {
    if (reasoningFormat === 'adaptive') {
      body.thinking = { type: 'adaptive' };
      body.output_config = { effort: 'high' };
    } else {
      const budgetTokens = ANTHROPIC_THINKING_BUDGET.high;
      body.thinking = {
        type: 'enabled',
        budget_tokens: budgetTokens,
      };
      // max_tokens 必须严格大于 budget_tokens，并额外预留回复 token。
      body.max_tokens = budgetTokens + ANTHROPIC_REPLY_TOKENS;
    }
  }
  return applyAnthropicCacheControl(body);
}
