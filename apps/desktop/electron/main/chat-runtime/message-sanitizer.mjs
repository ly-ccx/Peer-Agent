function hasContent(value) {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined;
}

function isEmptyAssistantMessage(message) {
  return (
    message?.role === 'assistant' &&
    !message?.tool_calls?.length &&
    !hasContent(message?.content)
  );
}

// 工具调用语法字面量（Claude 原生 tool_use 协议标记）。当不可信文本（tool_result
// 正文、历史 text 段、用户粘贴内容）里出现这些字面量时，会作为 few-shot 样例诱导模型
// 把工具调用吐进 text 通道（表现为 stop_reason=end_turn 却打印 <invoke> 文本，随后静默
// 断流）。这里只“中和”而非删除：把标签起始尖括号转义为 &lt;，打断语法链，但保留
// invoke/parameter 字样可读，分析含工具调用 trace 的会话不受影响。
// 仅作用于纯文本正文，绝不触碰结构化 tool_use block 的 input / openai tool_calls。
const TOOL_CALL_SYNTAX_PATTERN = /<(\/?)(?:(antml:)?(tool_call|function_calls|invoke|parameter)|(functions\.[a-zA-Z0-9_.-]+))\b/gi;

export function neutralizeToolCallSyntax(text) {
  if (typeof text !== 'string' || text.indexOf('<') === -1) return text;
  return text.replace(TOOL_CALL_SYNTAX_PATTERN, (_match, slash = '', namespace = '', claudeName = '', openAiName = '') => (
    `&lt;${slash}${namespace || ''}${claudeName || openAiName}`
  ));
}

// 对单个 content block 做中和：只处理 text 块的 text、tool_result 块的 content。
// tool_use（含 input 对象）、image 等结构化块原样返回，避免破坏合法协议。
function neutralizeContentBlock(block) {
  if (!block || typeof block !== 'object') return block;
  if (block.type === 'text' && typeof block.text === 'string') {
    return { ...block, text: neutralizeToolCallSyntax(block.text) };
  }
  if (block.type === 'tool_result') {
    if (typeof block.content === 'string') {
      return { ...block, content: neutralizeToolCallSyntax(block.content) };
    }
    if (Array.isArray(block.content)) {
      return { ...block, content: block.content.map(neutralizeContentBlock) };
    }
  }
  return block;
}

// 对一条消息的 content 做中和。content 可能是 string（OpenAI/Gemini tool 消息、
// 简单 user/assistant 文本）或 block 数组（Anthropic content blocks）。
function neutralizeMessageContent(message) {
  if (typeof message.content === 'string') {
    const next = neutralizeToolCallSyntax(message.content);
    return next === message.content ? message : { ...message, content: next };
  }
  if (Array.isArray(message.content)) {
    return { ...message, content: message.content.map(neutralizeContentBlock) };
  }
  return message;
}

// 中断/超时导致工具未产出结果时，为悬空的 assistant.tool_call 补的占位响应正文。
const TOOL_CALL_UNRESOLVED_PLACEHOLDER =
  '[tool call did not complete: the run was interrupted before this tool produced a result]';

// OpenAI 风格工具调用配对归一化。
//
// OpenAI/DeepSeek/qoder 协议要求：每条 role:'tool' 必须紧跟在声明了对应
// tool_call id 的 assistant 消息之后；反之，assistant 声明的每个 tool_call
// 也必须有一条配对的 tool 响应。任何一侧缺失都会被 provider 拒绝，报
// invalid_request_error: "Messages with role 'tool' must be a response to a
// preceding message with 'tool_calls'"。
//
// 历史消息在以下情况会破坏配对，需要在发送前修复：
//   1. 压缩（microcompaction）删掉了带 tool_calls 的 assistant，只留下 role:tool
//      → 形成“孤儿 tool”，直接丢弃。
//   2. 运行被中断/abort，assistant 声明了 tool_calls 但工具从未产出结果
//      → “悬空 tool_call”，补一条占位 tool 响应闭合配对。
//
// 该逻辑只针对 OpenAI 扁平结构（message.tool_calls / role:'tool' + tool_call_id）。
// Anthropic 的 tool_use / tool_result 走 content block，不涉及 role:'tool'，天然不受影响。
function normalizeToolCallPairing(messages) {
  // 收集所有 assistant 声明过的 tool_call id。
  const declaredIds = new Set();
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const tc of message.tool_calls) {
        if (tc?.id) declaredIds.add(tc.id);
      }
    }
  }

  // 收集已经有 tool 响应、且能对应上某个声明的 id。
  const respondedIds = new Set();
  for (const message of messages) {
    if (message.role === 'tool' && message.tool_call_id && declaredIds.has(message.tool_call_id)) {
      respondedIds.add(message.tool_call_id);
    }
  }

  const result = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      // 丢弃孤儿 tool：没有 tool_call_id，或找不到配对的 assistant 声明。
      if (!message.tool_call_id || !declaredIds.has(message.tool_call_id)) continue;
      result.push(message);
      continue;
    }

    result.push(message);

    // assistant 声明了 tool_calls：为任何缺失响应的 id 补占位，紧跟其后闭合配对。
    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      for (const tc of message.tool_calls) {
        if (tc?.id && !respondedIds.has(tc.id)) {
          result.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: TOOL_CALL_UNRESOLVED_PLACEHOLDER,
          });
          respondedIds.add(tc.id); // 防止同一 id 被重复补占位
        }
      }
    }
  }

  return result;
}

export function sanitizeApiMessages(messages) {
  const filtered = messages.filter((message) => {
    if (!message || typeof message !== 'object') return false;
    if (isEmptyAssistantMessage(message)) return false;
    if (message.role === 'system') return hasContent(message.content);
    if (message.role === 'user') return hasContent(message.content);
    if (message.role === 'assistant') return hasContent(message.content) || Boolean(message.tool_calls?.length);
    if (message.role === 'tool') return hasContent(message.content);
    return false;
  });

  return normalizeToolCallPairing(filtered).map(neutralizeMessageContent);
}
