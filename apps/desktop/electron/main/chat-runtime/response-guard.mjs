const UNSUPPORTED_TOOL_CLAIM_PATTERNS = [
  /\[Tool call:/i,
  /真实返回|工具返回|命令返回|实际返回|stdoutPreview|stderrPreview|exitCode|tool result|command returned|tool returned/i,
  /cat\s+出来|git status|npm run|pnpm|yarn|bun\s+run|sed -n|rg -n/i,
  /(?:发起|发出了|开始|重新)(?:[^。！？\n]{0,40})(?:bash|read_file|edit_file|write_file|工具)(?:[^。！？\n]{0,40})(?:调用|执行)/u,
  /我(?:已经|刚才|实际|真实|确实)(?:[^。！？\n]{0,24})?(?:执行|运行|检查|查|看|读取|读|写入|修改|改|验证|确认|回读|拿到)/u,
  /我(?:执行了|运行了|检查了|查了|看了|读取了|读了|写入了|写好了|修改了|改了|验证了|确认了|回读了|拿到了)/u,
  /\bI\s+(?:just\s+)?(?:ran|executed|checked|verified|read|wrote|modified|updated|confirmed)\b/i,
];

const DANGLING_TOOL_INTENT_PATTERNS = [
  /(?:先|我先|接下来|现在|马上|直接|准备)(?:[^。！？\n]{0,80})(?:查|看|定位|摸清|确认|验证|读取|读|搜索|执行|运行|改|修改|动手|回读|查询)(?:[^。！？\n]{0,100})(?:：|:)\s*$/u,
  /(?:先一次性查全|相关文件和关键代码|消息发送链路|输入区结构)(?:[^。！？\n]{0,80})(?:：|:)?\s*$/u,
  /我先(?:[^。！？\n]{0,120})(?:真实工具|工具真实返回|贴真实返回|每步贴)(?:[^。！？\n]{0,80})(?:。|！|!|：|:)?\s*$/u,
  /(?:真实工具|工具真实返回|贴真实返回|每步贴)(?:[^。！？\n]{0,100})(?:：|:)?\s*$/u,
  /\b(?:I(?:'ll| will| am going to)|Let me|I need to|I'll now)(?:.{0,100})(?:inspect|check|read|run|search|look|verify|modify|write)(?:.{0,80})(?::)?\s*$/is,
];

export function hasUnsupportedToolClaim(text) {
  const value = String(text || '');
  if (!value.trim()) return false;
  return UNSUPPORTED_TOOL_CLAIM_PATTERNS.some((pattern) => pattern.test(value));
}

export function hasDanglingToolIntent(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  return DANGLING_TOOL_INTENT_PATTERNS.some((pattern) => pattern.test(value));
}

export function shouldRetryNoToolResponse(text) {
  return hasUnsupportedToolClaim(text) || hasDanglingToolIntent(text);
}

export function unsupportedToolResponseCorrection() {
  return [
    'The previous assistant output claimed or promised local tool/file/command activity, but this turn emitted no actual tool call.',
    'Discard that output.',
    'If the user request requires local filesystem, git, shell, build, runtime, or verification facts, call an available tool now.',
    'Do not stop after a tool-use preamble. Either emit the tool call in this turn, or answer without claiming or promising local execution.',
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
