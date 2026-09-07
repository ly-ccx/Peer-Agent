// Empty write narration: claims a document/file write is underway without a real tool call.
// Kept separate so the agent loop can retry these without treating every prose claim as a hard fail.
const EMPTY_WRITE_NARRATION_PATTERNS = [
  /(?:正在写入|开始写入|写入完整|正在把|先把)(?:[^。！？\n]{0,48})?(?:文档|文件|调研|结论|内容)/u,
  /(?:now writing|writing (?:the )?(?:full )?(?:document|file)|start(?:ing)? to write)(?:[^.\n]{0,48})?(?:document|file|report)?/i,
];

const UNSUPPORTED_TOOL_CLAIM_PATTERNS = [
  /\[Tool call:/i,
  /真实返回|工具返回|命令返回|实际返回|stdoutPreview|stderrPreview|exitCode|tool result|command returned|tool returned/i,
  /(?:发起|发出了|开始|重新)(?:[^。！？\n]{0,40})(?:bash|read_file|edit_file|write_file|工具)(?:[^。！？\n]{0,40})(?:调用|执行)/u,
  ...EMPTY_WRITE_NARRATION_PATTERNS,
  /我(?:已经|刚才|实际|真实|确实)(?:[^。！？\n]{0,24})?(?:执行|运行|检查|查|看|读取|读|写入|修改|改|验证|确认|回读|拿到)/u,
  /我(?:执行了|运行了|检查了|查了|看了|读取了|读了|写入了|写好了|修改了|改了|验证了|确认了|回读了|拿到了)/u,
  /\bI\s+(?:just\s+)?(?:ran|executed|checked|verified|read|wrote|modified|updated|confirmed)\b/i,
];

export function hasUnsupportedToolClaim(text) {
  const value = String(text || '');
  if (!value.trim()) return false;
  return UNSUPPORTED_TOOL_CLAIM_PATTERNS.some((pattern) => pattern.test(value));
}

export function hasEmptyWriteNarration(text) {
  const value = String(text || '');
  if (!value.trim()) return false;
  return EMPTY_WRITE_NARRATION_PATTERNS.some((pattern) => pattern.test(value));
}

// 口述下一步本地行动但本轮没有 tool_call：这是未完成行动，不是可收束答案。
const INCOMPLETE_ACTION_NARRATION_PATTERNS = [
  /(?:让我先?|我去|先(?:精确|完整)?|现在|并行)(?:读取|读一下|读这两个|读文件|读定义|读\s*`|读)/u,
  /(?:用|发出|真正发出)\s*(?:read_file|bash|grep|batch_search|edit_file|write_file)/i,
  /(?:完整拉通|一次拉全|把关键文件.{0,16}读|先完整读)/u,
  /\b(?:let me|i(?:'ll| will)|now)\s+(?:read|search|grep|inspect)\b/i,
  /\bi need to read\b/i,
];

export function hasIncompleteActionNarration(text) {
  const value = String(text || '');
  if (!value.trim()) return false;
  return INCOMPLETE_ACTION_NARRATION_PATTERNS.some((pattern) => pattern.test(value));
}

// 模型把工具调用吐进 text 通道的症状：正文里出现 tool_use 协议的字面量
// （<tool_call> / <function_calls> / <invoke ...> / <parameter ...>，含 antml: 命名空间变体），但这一轮
// stop_reason 并非 tool_use，于是不会被当成真实调用执行。命中时应触发静默重试纠偏，
// 而不是 sendDone 直接断流。注意：此处检测的是模型本轮新生成、尚未经发送侧中和的输出，
// 故匹配未转义的 < 形态，也覆盖部分模型把标签 HTML-escape 成 &lt;tool_call&gt;
// 的情况，避免转义后的协议文本进入 UI 正文。
const LITERAL_TOOL_CALL_SYNTAX_PATTERN = /(?:<|&lt;)(?:\/?)(?:(?:antml:)?(?:tool_call|function_calls|invoke|parameter)|functions\.[a-zA-Z0-9_.-]+)\b/i;

export function hasLiteralToolCallSyntax(text) {
  const value = String(text || '');
  if (value.indexOf('<') === -1 && !/&lt;/i.test(value)) return false;
  return LITERAL_TOOL_CALL_SYNTAX_PATTERN.test(value);
}

export function shouldRetryNoToolResponse(text) {
  // 无 tool_call 的正文默认不是终态：协议泄漏、空写声称、已执行声称、
  // 以及「我去读/搜」这类未完成行动，都必须在同一 loop 里重试。
  return hasLiteralToolCallSyntax(text)
    || hasEmptyWriteNarration(text)
    || hasUnsupportedToolClaim(text)
    || hasIncompleteActionNarration(text);
}

export function unsupportedToolResponseCorrection() {
  return [
    'The previous assistant output narrated a local action or leaked tool protocol, but this turn produced no executable tool call.',
    'Discard that output.',
    'Do not narrate "writing" / "正在写入" / "开始写入" / "我去读" / "先读取" / "Let me read" as if the action is already in progress.',
    'In this turn, emit a real tool call first (read_file, bash, edit_file, or write_file); only after the tool result may you claim the work happened.',
    'For large documents, use chunked writes only: write_file content must stay within 32KB (UTF-8); create a short skeleton with write_file, then append/revise with multiple edit_file calls.',
    'Never emit one giant write_file payload for multi-section docs — that stalls the provider stream and times out.',
    'If the user request requires local filesystem, git, shell, build, runtime, or verification facts, call an available tool now.',
    'Do not print tool-call markup as normal text. Either emit the tool call in this turn, or answer in normal prose without protocol tags.',
  ].join(' ');
}

export function unsupportedToolResponseError({ providerTracePath = null } = {}) {
  const suffix = providerTracePath ? ` provider_trace=${providerTracePath}` : '';
  return `unsupported_tool_response: 模型把工具调用协议文本输出到了正文里，但没有产生可执行工具调用；已重试后仍失败。${suffix}`;
}

export function thinkingOnlyResponseError({ providerTracePath = null } = {}) {
  const suffix = providerTracePath ? ` provider_trace=${providerTracePath}` : '';
  return `thinking_only_response: 模型只返回了思考内容，没有返回正文或可执行工具调用；已重试后仍失败。${suffix}`;
}

export function thinkingOnlyResponseCorrection() {
  return [
    'The previous response contained only hidden reasoning and no final answer or real tool call.',
    'Discard that reasoning-only output.',
    'If the task requires local filesystem, git, shell, build, runtime, or verification facts, call an available tool now.',
    'Otherwise provide a final text answer. Do not stop after a planning or tool-use preamble.',
  ].join(' ');
}

export function emptyModelResponseError({ providerTracePath = null } = {}) {
  const suffix = providerTracePath ? ` provider_trace=${providerTracePath}` : '';
  return `empty_model_response: 模型没有返回任何文本或工具调用，请检查当前模型、baseUrl、API 兼容性或模型是否支持当前请求格式。${suffix}`;
}

export function emptyModelResponseCorrection() {
  return [
    'The previous model response was empty immediately after tool results.',
    'Continue from the actual tool results already provided.',
    'Emit either a normal text answer or another real tool call.',
    'Do not return an empty assistant message.',
  ].join(' ');
}
