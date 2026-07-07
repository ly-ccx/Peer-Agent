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

export function sanitizeApiMessages(messages) {
  return messages
    .filter((message) => {
      if (!message || typeof message !== 'object') return false;
      if (isEmptyAssistantMessage(message)) return false;
      if (message.role === 'system') return hasContent(message.content);
      if (message.role === 'user') return hasContent(message.content);
      if (message.role === 'assistant') return hasContent(message.content) || Boolean(message.tool_calls?.length);
      if (message.role === 'tool') return hasContent(message.content);
      return false;
    })
    .map(neutralizeMessageContent);
}
