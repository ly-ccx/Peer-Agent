import { COLOR } from './tui-theme.ts';
import {
  isRequestUserInputTool,
  type ToolPresentation,
} from './tool-result-summary.ts';

export interface TuiUserInputOption {
  readonly label: string;
  readonly shortcut: string;
  readonly color: string;
}

export interface TuiUserInputRequest {
  readonly question: string;
  readonly options: readonly string[];
  readonly note: string | null;
  readonly toolCallId?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);
}

function extractQuestionAndOptions(
  primary: unknown,
  fallback: unknown,
): { question: string; options: string[]; note: string | null } {
  const primaryRecord = asRecord(primary) ?? {};
  const fallbackRecord = asRecord(fallback) ?? {};

  const question = typeof primaryRecord.question === 'string' && primaryRecord.question.trim()
    ? primaryRecord.question.trim()
    : typeof fallbackRecord.question === 'string' && fallbackRecord.question.trim()
      ? fallbackRecord.question.trim()
      : '';

  const options = asStringList(primaryRecord.options);
  const fallbackOptions = options.length > 0 ? options : asStringList(fallbackRecord.options);

  const note = typeof primaryRecord.note === 'string' && primaryRecord.note.trim()
    ? primaryRecord.note.trim()
    : typeof fallbackRecord.note === 'string' && fallbackRecord.note.trim()
      ? fallbackRecord.note.trim()
      : null;

  return { question, options: fallbackOptions, note };
}

export function extractUserInputRequest(
  tool: ToolPresentation | null | undefined,
): TuiUserInputRequest | null {
  if (!tool || !isRequestUserInputTool(tool.capabilityId)) return null;

  // Prefer structured arguments; fall back to output-shaped detail parsing only via args.
  const fromArgs = extractQuestionAndOptions(tool.arguments, tool.arguments);
  let question = fromArgs.question;
  let options = fromArgs.options;
  let note = fromArgs.note;

  // When arguments were not retained (legacy), recover options from detail lines like "  1. foo".
  if (!question && tool.argumentSummary.trim()) {
    question = tool.argumentSummary.trim();
  }
  if (options.length === 0 && tool.detailLines.length > 0) {
    const recovered: string[] = [];
    for (const line of tool.detailLines) {
      const match = /^\s*(\d+)\.\s+(.+)$/.exec(line);
      if (match?.[2]) recovered.push(match[2].trim());
    }
    if (recovered.length > 0) options = recovered;
  }
  if (!question && tool.detailLines[0]) {
    // First detail line is usually the question in formatInteractionToolDetail.
    const first = tool.detailLines[0].trim();
    if (first && !/^\d+\.\s+/.test(first) && first !== 'Options:') {
      question = first;
    }
  }

  if (!question) return null;
  return {
    question,
    options,
    note,
    ...(tool.toolCallId ? { toolCallId: tool.toolCallId } : {}),
  };
}

export function toUserInputOptions(options: readonly string[]): readonly TuiUserInputOption[] {
  return options.map((label, index) => ({
    label,
    shortcut: String(index + 1),
    color: COLOR.accent,
  }));
}

export function moveUserInputSelection(current: number, offset: number, itemCount: number): number {
  if (itemCount <= 0) return 0;
  return ((current + offset) % itemCount + itemCount) % itemCount;
}

/**
 * Map a key to a selected option label.
 * - digits 1-9 choose by shortcut
 * - enter/return confirms the highlighted option
 * Free text is intentionally not handled here (composer path).
 */
export function userInputDecisionForKey(
  keyName: string,
  selectedIndex: number,
  options: readonly string[],
): string | null {
  if (options.length === 0) return null;
  if (/^[1-9]$/.test(keyName)) {
    const index = Number(keyName) - 1;
    return options[index] ?? null;
  }
  if (keyName === 'return' || keyName === 'enter') {
    return options[selectedIndex] ?? null;
  }
  return null;
}
