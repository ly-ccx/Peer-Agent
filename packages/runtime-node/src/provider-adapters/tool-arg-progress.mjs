// 工具调用参数流式进度（Codex 式实时体感）。
//
// 背景：工具调用参数（尤其 edit_file / write_file 的整文件内容）以增量分片
// （Anthropic input_json_delta / OpenAI function_call_arguments.delta / chat
// tool_calls[].function.arguments）逐步抵达。在参数累积完成、落地为
// chat:stream:tool-call 之前，renderer 对“正在写什么、写了多少”完全不可见，
// 长编辑会表现为“一直等待中”。
//
// 本模块在三个 provider 适配器之间共享“解析 path / 估算行数 / 节流 / 发送”逻辑，
// 统一发出 chat:stream:tool-progress 事件，避免三份拷贝（增加 Locality）。
//
// 边界：这是 provider 适配层的“流式进度提示”，属于运行时投影的瞬时反馈，
// 不替代真正的 Tool Result / Evidence。事实仍由后续 chat:stream:tool-call
// 与本地能力执行结果（PermissionGrant -> Evidence）接管。

const TOOL_ARG_PROGRESS_INTERVAL_MS = 120;

// 从增量累积的 JSON 片段中尽早解析 path。
// path 通常出现在 JSON 前部，远早于整段文件内容到达，可第一时间展示文件名。
function tryParsePath(json) {
  const match = /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(json);
  if (!match) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return match[1];
  }
}

/**
 * 在工具参数流式累积期间，发出节流后的 tool-progress 事件。
 *
 * @param {object} progress  per-tool-call 的可变进度状态（由调用方持有并复用），
 *   本模块会在其上记录 argPath / lastProgressAt。
 * @param {object} ctx
 * @param {Electron.WebContents} ctx.webContents
 * @param {string} ctx.streamId
 * @param {string} ctx.toolCallId
 * @param {string} ctx.toolName
 * @param {string} ctx.argsJson  当前已累积的参数 JSON 文本。
 */
export function emitToolArgProgress(progress, ctx) {
  if (!progress || !ctx) return;
  const { webContents, streamId, toolCallId, toolName, argsJson } = ctx;
  if (!webContents || webContents.isDestroyed?.()) return;
  const json = argsJson || '';

  if (progress.argPath === undefined) {
    const parsed = tryParsePath(json);
    if (parsed !== undefined) progress.argPath = parsed;
  }

  // JSON 转义后的换行表现为字面量 \n，据此估算“已接收行数”。
  const receivedLines = (json.match(/\\n/g) || []).length;
  const now = Date.now();
  if (
    progress.lastProgressAt &&
    now - progress.lastProgressAt < TOOL_ARG_PROGRESS_INTERVAL_MS
  ) {
    return;
  }
  progress.lastProgressAt = now;

  webContents.send('chat:stream:tool-progress', {
    streamId,
    toolCallId,
    tool: toolName,
    path: progress.argPath ?? null,
    receivedChars: json.length,
    receivedLines,
  });
}
