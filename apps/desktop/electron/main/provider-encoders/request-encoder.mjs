import {
  normalizeAnthropicMessages,
  normalizeOpenAIMessages,
} from './message-normalizer.mjs';

// OpenAI GPT-5.5 原生 reasoning_effort 支持 none/low/medium/high/xhigh。
// Peer Agent 的 off 不发 reasoning_effort；其余档位按 provider wire 契约透传。
const OPENAI_REASONING_EFFORT = { low: 'low', default: 'medium', high: 'high', xhigh: 'xhigh' };
const ANTHROPIC_THINKING_BUDGET = { low: 4096, default: 10240, high: 32768, xhigh: 32768 };
const QWEN_THINKING_BUDGET = { low: 1024, default: 4096, high: 8192, xhigh: 16384 };
// Anthropic output_config.effort 原生枚举为 low/medium/high/xhigh/max（与 thinking 是
// adaptive 还是 enabled 无关，effort 始终属于顶层 output_config）。Peer Agent 的 xhigh
// 忠实映射到原生 xhigh；max 无对应 UI 档位，按 YAGNI 不引入。
const ANTHROPIC_OUTPUT_EFFORT = { low: 'low', default: 'medium', high: 'high', xhigh: 'xhigh' };
// Anthropic 约束: max_tokens 必须 > thinking.budget_tokens。
// max_tokens 是 (思考 token + 回复 token) 的总额，因此开启 thinking 时
// 需要在 budget 之上额外预留回复预算，否则 API 返回 400 导致请求必挂。
const ANTHROPIC_REPLY_TOKENS = 16384;

function positiveTokenLimit(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : fallback;
}

function mappedEffortValue(effort, map, fallbackMap, fallbackKey = 'default') {
  const key = effort === 'default' ? 'medium' : effort;
  const candidates = effort === 'default' ? ['default', 'medium'] : [String(effort || '')];
  for (const candidate of candidates) {
    const value = map?.[candidate];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return fallbackMap?.[effort] ?? fallbackMap?.[key] ?? fallbackMap?.[fallbackKey];
}

function mappedNumericEffort(effort, map, fallbackMap) {
  const mapped = mappedEffortValue(effort, map, fallbackMap);
  const num = Number(mapped);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : undefined;
}

// Opus 4.8 / Fable 5 / Mythos 5 等新代际模型用 output_config.effort 控制思考强度，
// 不再支持 manual extended thinking(thinking.budget_tokens)，强行发送会被 API 拒绝(400)。
// 这里按 model id 识别这一代际，让 encoder 在 wire 层切到 effort 契约。
const ANTHROPIC_EFFORT_NATIVE_PATTERNS = [/opus-4-8/, /opus-4\.8/, /fable/, /mythos/];
function anthropicModelUsesEffortConfig(model) {
  if (typeof model !== 'string') return false;
  const id = model.toLowerCase();
  return ANTHROPIC_EFFORT_NATIVE_PATTERNS.some((re) => re.test(id));
}

export function encodeOpenAIChatRequest({
  model,
  messages,
  tools,
  effort = 'default',
  supportsReasoning = false,
  reasoningParamStyle = 'openai-effort',
  promptCaching = false,
  maxOutputTokens,
  reasoningEffortMap,
}) {
  const body = {
    model,
    messages: normalizeOpenAIMessages(messages),
    stream: true,
    stream_options: { include_usage: true },
    tools,
  };
  const outputLimit = positiveTokenLimit(maxOutputTokens, null);
  if (outputLimit) body.max_tokens = outputLimit;
  // OpenAI-compatible 协议（含 DeepSeek）的缓存为服务端自动检测，不需要客户端在
  // content block 上打 cache_control 断点（与 Anthropic 不同）。promptCaching 仅
  // 作为 UI 标志沿链路传递，后端 usage 解析已从 cached_tokens 字段提取命中量。
  void promptCaching;
  // 思考档位: off(关闭) / low / default / high / xhigh。
  // off 不发 reasoning_effort; 其余档位映射到 OpenAI 原生 low/medium/high/xhigh。
  if (supportsReasoning && reasoningParamStyle === 'openai-effort' && effort && effort !== 'off') {
    body.reasoning_effort = mappedEffortValue(effort, reasoningEffortMap, OPENAI_REASONING_EFFORT, 'default') ?? 'medium';
  } else if (supportsReasoning && reasoningParamStyle === 'qwen-enable' && effort && effort !== 'off') {
    body.enable_thinking = true;
    body.thinking_budget = mappedNumericEffort(effort, reasoningEffortMap, QWEN_THINKING_BUDGET) ?? QWEN_THINKING_BUDGET.default;
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
  reasoningParamStyle = null,
  reasoningFormat = 'enabled',
  promptCaching = true,
  maxOutputTokens,
  reasoningEffortMap,
}) {
  const replyTokenLimit = positiveTokenLimit(maxOutputTokens, ANTHROPIC_REPLY_TOKENS);
  const body = {
    model,
    system,
    messages: normalizeAnthropicMessages(messages),
    max_tokens: replyTokenLimit,
    stream: true,
    tools,
  };
  // 思考档位: off(关闭) / low / default / high / xhigh。
  // off 不开 thinking; output_config.effort 原生支持 xhigh，直接透传(adaptive/output-effort
  // 两条链路都走 output_config.effort)。enabled-budget 旧代际无 effort，按 budget_tokens 折算。
  const paramStyle = reasoningParamStyle
    ?? (reasoningFormat === 'adaptive' ? 'anthropic-adaptive-effort' : null)
    ?? (anthropicModelUsesEffortConfig(model) ? 'anthropic-output-effort' : 'anthropic-enabled-budget');
  if (supportsReasoning && effort && effort !== 'off') {
    if (paramStyle === 'anthropic-adaptive-effort') {
      // display:'summarized' 让思维链以摘要形式回流，否则新代际默认 omitted
      // (thinking 字段恒空、仅 signature)，UI 的思考区永远无内容可渲染。
      body.thinking = { type: 'adaptive', display: 'summarized' };
      body.output_config = { effort: mappedEffortValue(effort, reasoningEffortMap, ANTHROPIC_OUTPUT_EFFORT, 'default') ?? 'medium' };
    } else if (paramStyle === 'anthropic-output-effort') {
      // Opus 4.8 等新代际: 不发 thinking.budget_tokens(会 400)，
      // 改用 output_config.effort，max_tokens 保持纯回复预算。
      // display 默认 omitted(只回加密 signature)，必须显式 summarized 才会流式回传
      // 可见的摘要思考；type:'adaptive' 是这一代际的推荐用法，与 effort 配套不冲突。
      body.thinking = { type: 'adaptive', display: 'summarized' };
      body.output_config = { effort: mappedEffortValue(effort, reasoningEffortMap, ANTHROPIC_OUTPUT_EFFORT, 'default') ?? 'medium' };
    } else if (paramStyle === 'anthropic-enabled-budget') {
      const budgetTokens = mappedNumericEffort(effort, reasoningEffortMap, ANTHROPIC_THINKING_BUDGET) ?? ANTHROPIC_THINKING_BUDGET.default;
      body.thinking = {
        type: 'enabled',
        budget_tokens: budgetTokens,
      };
      // max_tokens 必须严格大于 budget_tokens，并额外预留回复 token。
      body.max_tokens = budgetTokens + replyTokenLimit;
    }
  }
  // 部分网关(如 idealab adaptive 链路)只写缓存、从不返回 cache_read，
  // 实测探针证明缓存断点在该链路是纯成本(写入 $6.25/M)而无复用收益。
  // 这类链路关闭断点，让前缀退化为普通 input($5/M)，反而更省。
  if (!promptCaching) return body;
  return applyAnthropicCacheControl(body);
}
