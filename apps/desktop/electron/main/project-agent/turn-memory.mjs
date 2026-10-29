/**
 * 项目代理回合把已完成的工具调用记在 toolContext 上，
 * 后面的 post_reply 才能把 memory_remember 的 id 交给 ReplyComposer。
 * 只有宿主事先放了数组的回合才记录。
 */
export function noteTurnToolCall(toolContext, call) {
  if (!toolContext || typeof toolContext !== 'object' || Array.isArray(toolContext)) return;
  if (!Array.isArray(toolContext.turnToolCalls)) return;
  toolContext.turnToolCalls.push({
    name: typeof call?.name === 'string' ? call.name : '',
    input: call?.input ?? null,
    result: parseToolResult(call?.result),
  });
}

function parseToolResult(value) {
  if (typeof value !== 'string') return value ?? null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}
