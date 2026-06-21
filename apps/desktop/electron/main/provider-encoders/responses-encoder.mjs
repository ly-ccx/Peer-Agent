// OpenAI Responses API 请求编码(ChatGPT 订阅链路)。ADR 28。
//
// 订阅账号走 Responses API,其 wire body 与 /chat/completions 不同:
// - 顶层用 instructions(system) + input(对话项数组)。
// - 工具用 type: 'function' 扁平结构。
// - 流式事件是 typed events(response.output_text.delta 等),由 responses-adapter 解析。
//
// 这里只负责 chat-style 内部消息 -> Responses input 的纯函数转换,无副作用。

import { normalizeOpenAIMessages } from './message-normalizer.mjs';

// OpenAI GPT-5.5 Responses reasoning.effort 支持 none/low/medium/high/xhigh。
// Peer Agent 的 off 不发 reasoning；其余档位按 provider wire 契约透传。
const REASONING_EFFORT = { low: 'low', default: 'medium', high: 'high', xhigh: 'xhigh' };

function positiveTokenLimit(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : null;
}

function mappedEffortValue(effort, map) {
  if (!map || typeof map !== 'object') return undefined;
  if (effort === 'default') return map.default ?? map.medium;
  return map[effort];
}

function textPart(text) {
  return { type: 'input_text', text };
}

// 把一条内部消息(chat 格式)转换为 Responses input item(可能展开为多项)。
function toInputItems(msg) {
  if (!msg || typeof msg !== 'object') return [];

  // 工具结果:Responses 用 function_call_output。
  if (msg.role === 'tool') {
    return [
      {
        type: 'function_call_output',
        call_id: msg.tool_call_id,
        output: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? ''),
      },
    ];
  }

  // assistant 的 tool_calls:展开为 function_call 项。
  if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    const items = [];
    const text = typeof msg.content === 'string' ? msg.content : '';
    if (text) {
      items.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
    }
    for (const tc of msg.tool_calls) {
      items.push({
        type: 'function_call',
        call_id: tc.id,
        name: tc.function?.name,
        arguments: tc.function?.arguments ?? '',
      });
    }
    return items;
  }

  // 普通文本消息。assistant 用 output_text,其余用 input_text。
  const role = msg.role === 'assistant' ? 'assistant' : msg.role === 'system' ? 'system' : 'user';
  if (typeof msg.content === 'string') {
    const partType = role === 'assistant' ? 'output_text' : 'input_text';
    return [{ role, content: [{ type: partType, text: msg.content }] }];
  }
  if (Array.isArray(msg.content)) {
    const parts = [];
    for (const block of msg.content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        parts.push(role === 'assistant' ? { type: 'output_text', text: block.text } : textPart(block.text));
      } else if (block?.type === 'image_url' && block.image_url?.url) {
        parts.push({ type: 'input_image', image_url: block.image_url.url });
      } else if (block?.type === 'input_image' && block.image_url) {
        parts.push({ type: 'input_image', image_url: block.image_url });
      }
    }
    return parts.length ? [{ role, content: parts }] : [];
  }
  return [];
}

// chat 风格工具定义 -> Responses 扁平 function 工具。
function toResponsesTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools
    .map((t) => {
      const fn = t?.function || t;
      if (!fn?.name) return null;
      return {
        type: 'function',
        name: fn.name,
        description: fn.description,
        parameters: fn.parameters,
      };
    })
    .filter(Boolean);
}

export function encodeOpenAIResponsesRequest({
  model,
  messages,
  tools,
  effort = 'default',
  supportsReasoning = false,
  reasoningParamStyle = 'openai-effort',
  maxOutputTokens,
  reasoningEffortMap,
  omitMaxOutputTokens = false,
}) {
  const normalized = normalizeOpenAIMessages(messages);

  // 抽出 system 作为 instructions,其余进 input。
  const instructions = normalized
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .filter(Boolean)
    .join('\n\n');

  const input = [];
  for (const m of normalized) {
    if (m.role === 'system') continue;
    input.push(...toInputItems(m));
  }

  const body = {
    model,
    instructions: instructions || undefined,
    input,
    stream: true,
    store: false,
    tools: toResponsesTools(tools),
  };
  const outputLimit = positiveTokenLimit(maxOutputTokens);
  if (!omitMaxOutputTokens && outputLimit) body.max_output_tokens = outputLimit;

  if (supportsReasoning && reasoningParamStyle === 'openai-effort' && effort && effort !== 'off') {
    body.reasoning = { effort: mappedEffortValue(effort, reasoningEffortMap) ?? REASONING_EFFORT[effort] ?? 'medium', summary: 'auto' };
  }
  return body;
}
