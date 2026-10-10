// 工具卡展示：把 tool-call 段的 result 收成用户能读的终态。
// 这是表达层事实投影，不执行工具，也不补写 Evidence。
//
// read_file 成功时 result 是 local_file_ref JSON；失败时是带 reason/error 的
// JSON，或主进程 materializeToolOutput 写出的 `Error: ...`。`null` / 缺省 /
// 字面量 "null" 都不是工具输出，只表示结果没到或被写成了空值。

import { isBlankToolResult, isPendingToolResult } from './streamSegments.ts';

export type ToolCallPresentationPhase =
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'incomplete'
  | 'failed';

export interface ToolCallPresentation {
  readonly phase: ToolCallPresentationPhase;
  /** 标题行上的终态短标签；进行中和正常完成不占这个位置。 */
  readonly statusLabel: string | null;
  /** 展开后的「返回内容」。进行中为 null，由卡片显示「正在执行…」。 */
  readonly body: string | null;
}

export function presentToolCall({
  result,
  turnSettled,
  interrupted,
  isZh,
}: {
  readonly result: string | null | undefined;
  readonly turnSettled: boolean;
  readonly interrupted: boolean;
  readonly isZh: boolean;
}): ToolCallPresentation {
  if (typeof result === 'string') {
    const notePhase = classifyTerminalNote(result);
    if (notePhase === 'cancelled') {
      return {
        phase: 'cancelled',
        statusLabel: isZh ? '已取消' : 'Cancelled',
        body: result.trim(),
      };
    }
    if (notePhase === 'incomplete') {
      return {
        phase: 'incomplete',
        statusLabel: isZh ? '未返回' : 'No result',
        body: result.trim(),
      };
    }
  }

  // 字面量 "null" 是空结果，不是仍在执行。轮次是否还在流式都不该继续转圈。
  if (typeof result === 'string' && result.trim() === 'null') {
    return settledMissing(interrupted, isZh);
  }

  if (isPendingToolResult(result) || isBlankToolResult(result)) {
    if (!turnSettled) {
      return { phase: 'running', statusLabel: null, body: null };
    }
    return settledMissing(interrupted, isZh);
  }

  if (typeof result === 'string' && result.startsWith('Error:')) {
    return {
      phase: 'failed',
      statusLabel: isZh ? '失败' : 'Failed',
      body: result,
    };
  }

  const failure = typeof result === 'string' ? toolResultFailureReason(result) : null;
  if (failure && typeof result === 'string') {
    const raw = result.trim();
    const body = raw === failure || raw.startsWith(failure) ? raw : `${failure}\n${raw}`;
    return {
      phase: 'failed',
      statusLabel: isZh ? '失败' : 'Failed',
      body,
    };
  }

  return {
    phase: 'completed',
    statusLabel: null,
    body: typeof result === 'string' && result.trim() ? result : null,
  };
}

function settledMissing(interrupted: boolean, isZh: boolean): ToolCallPresentation {
  if (interrupted) {
    return {
      phase: 'cancelled',
      statusLabel: isZh ? '已取消' : 'Cancelled',
      body: isZh ? '这次调用已取消，没有返回内容。' : 'This call was cancelled and returned no content.',
    };
  }
  return {
    phase: 'incomplete',
    statusLabel: isZh ? '未返回' : 'No result',
    body: isZh ? '工具没有返回内容。' : 'The tool did not return any content.',
  };
}

/** 终态兜底写入的整段说明。只匹配说明本身，避免把文件正文里的同名句子当成中断。 */
function classifyTerminalNote(result: string): 'cancelled' | 'incomplete' | null {
  const text = result.trim();
  if (text === '工具调用已中断' || text.startsWith('工具调用已中断（')) return 'cancelled';
  if (text.startsWith('工具结果未返回（')) return 'incomplete';
  return null;
}

/**
 * 从工具结果 JSON 里抽出失败原因。
 * 成功的 local_file_ref（status 不是 failed/blocked/cancelled，且 success 不是 false）返回 null。
 */
export function toolResultFailureReason(result: string): string | null {
  const trimmed = result.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const status = typeof record.status === 'string' ? record.status : '';
  const failed = status === 'failed'
    || status === 'blocked'
    || status === 'cancelled'
    || record.success === false;
  if (!failed) return null;
  const reason = typeof record.reason === 'string' ? record.reason.trim() : '';
  const error = typeof record.error === 'string' ? record.error.trim() : '';
  return reason || error || status || null;
}
