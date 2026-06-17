/**
 * request_user_input 工具结果的「可交互视图」投影 —— 见 docs/proposals/0004-goal-mode-runtime-gate.md。
 *
 * 表达层职责：把主进程返回的 factual tool result（JSON 字符串）规范化为一个只读视图，
 * 供 UI 渲染「问题 + 可点击选项 + 等待你输入」。它不持有权限/终止真相——那由主进程的
 * control signal 决定；这里只做受治理的事实投影，不提升为 system 指令。
 */

export interface InteractionToolView {
  readonly question: string;
  readonly options: readonly string[];
  readonly note?: string;
}

const REQUEST_USER_INPUT_TOOL = 'request_user_input';

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * 仅当工具是 request_user_input 且结果可解析出 question 时返回视图，否则返回 null
 * （调用方据此回退到原始渲染）。
 */
export function parseInteractionToolView(
  toolName: string | undefined,
  rawResult: string | undefined,
): InteractionToolView | null {
  if (toolName !== REQUEST_USER_INPUT_TOOL) return null;
  if (typeof rawResult !== 'string' || rawResult.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawResult);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const record = parsed as Record<string, unknown>;
  const question = asString(record.question);
  if (!question) return null;

  const options = Array.isArray(record.options)
    ? record.options.filter((o): o is string => typeof o === 'string' && o.length > 0)
    : [];
  const note = asString(record.note);

  return { question, options, note };
}
