import {
  SHARED_LOCAL_TOOL_CONTRACTS,
  canonicalizeLocalCapabilityId,
} from '@peer-agent/runtime-core';

import { TOOL_CHROME } from './tui-theme.ts';

const DEFAULT_MAX_LENGTH = 1_200;
const DEFAULT_INLINE_MAX_LENGTH = 120;
const DEFAULT_DETAIL_PREVIEW_LINES = 3;
const DEFAULT_DETAIL_LINE_MAX = 100;

export type ToolPresentationStatus =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'denied'
  | 'running'
  | 'unknown';

const GOAL_STATUS_CAPABILITY_IDS = new Set<string>([
  SHARED_LOCAL_TOOL_CONTRACTS.goalCreatePlan.capabilityId,
  SHARED_LOCAL_TOOL_CONTRACTS.goalUpdateTask.capabilityId,
  SHARED_LOCAL_TOOL_CONTRACTS.goalGetPlan.capabilityId,
]);

export interface ToolPresentation {
  readonly capabilityId: string;
  readonly toolName: string;
  readonly argumentSummary: string;
  readonly status: ToolPresentationStatus;
  readonly detail: string;
  readonly detailLines: readonly string[];
  /** Real wall-clock timing captured around host execution. */
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly durationMs?: number;
  /** Stable tool-call id for Desktop segments / API replay. */
  readonly toolCallId?: string;
  /** Original tool arguments retained for Desktop segment.args. */
  readonly arguments?: Record<string, unknown> | null;
}

export function toolResultInlineSummary(
  content: string,
  maxLength = DEFAULT_INLINE_MAX_LENGTH,
): string {
  const singleLine = content
    .replace(/\s+/g, ' ')
    .trim();
  if (!singleLine) return 'completed';
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function toggleToolDetails(current: boolean): boolean {
  return !current;
}

function stableJson(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, nested) => {
    if (typeof nested === 'bigint') return nested.toString();
    if (!nested || typeof nested !== 'object') return nested;
    if (seen.has(nested)) return '[Circular]';
    seen.add(nested);
    if (Array.isArray(nested)) return nested;
    return Object.fromEntries(
      Object.entries(nested as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right)),
    );
  }, 2);
}


export function isRequestUserInputTool(name: string | null | undefined): boolean {
  if (!name) return false;
  return name === 'request_user_input'
    || name === 'local.interaction.request_user_input'
    || name.endsWith('.request_user_input')
    || name.endsWith('request_user_input');
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
}

/**
 * Project request_user_input tool output into a selectable / free-input card for TUI.
 * Expression-layer only: does not own permission/terminal truth.
 */
export function formatInteractionToolDetail(
  value: unknown,
  args?: Record<string, unknown> | null,
): string | null {
  const record = asRecord(value) ?? {};
  const argRecord = args ?? {};
  const question = typeof record.question === 'string' && record.question.trim()
    ? record.question.trim()
    : typeof argRecord.question === 'string' && argRecord.question.trim()
      ? argRecord.question.trim()
      : '';
  if (!question && !asStringList(record.options).length && !asStringList(argRecord.options).length) {
    // Not an interaction payload.
    if (record.ok !== true && record.acknowledged !== true) return null;
  }
  if (!question && record.ok !== true && record.acknowledged !== true) return null;

  const options = asStringList(record.options).length
    ? asStringList(record.options)
    : asStringList(argRecord.options);
  const note = typeof record.note === 'string' && record.note.trim()
    ? record.note.trim()
    : '';

  const lines: string[] = [];
  if (question) lines.push(question);
  if (options.length > 0) {
    lines.push('Options:');
    options.forEach((option, index) => {
      lines.push(`  ${index + 1}. ${option}`);
    });
    lines.push('Reply with a number or type your answer.');
  } else {
    lines.push('Type your answer in the input below.');
  }
  if (note) lines.push(note);
  return lines.join('\n');
}

export function formatToolResultSummary(
  value: unknown,
  fallback = 'completed',
  maxLength = DEFAULT_MAX_LENGTH,
): string {
  const interactionDetail = formatInteractionToolDetail(value);
  if (interactionDetail) {
    if (interactionDetail.length <= maxLength) return interactionDetail;
    return `${interactionDetail.slice(0, Math.max(0, maxLength - 1))}…`;
  }

  let formatted: string;
  if (typeof value === 'string') {
    formatted = value;
  } else if (value === undefined || value === null) {
    formatted = fallback;
  } else {
    try {
      formatted = stableJson(value) ?? fallback;
    } catch {
      formatted = fallback;
    }
  }

  if (formatted.length <= maxLength) return formatted;
  return `${formatted.slice(0, Math.max(0, maxLength - 1))}…`;
}

const TOOL_DISPLAY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  // Local capability ids
  'local.shell.exec': 'Bash',
  'local.file.read': 'Read',
  'local.file.write': 'Write',
  'local.file.list': 'List',
  'local.search.content': 'Search',
  'local.search.files': 'Search',
  'local.search.aggregate': 'Search',
  'local.interaction.request_user_input': 'Ask user',
  request_user_input: 'Ask user',
  // Common model-facing / provider tool names (kind labels in the timeline)
  bash: 'Bash',
  shell: 'Bash',
  read_file: 'Read',
  read: 'Read',
  write_file: 'Write',
  write: 'Write',
  edit_file: 'Write',
  search_files: 'Search',
  batch_search: 'Search',
  grep: 'Search',
  glob: 'Search',
});

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function compactText(value: string, maxLength = 72): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  if (!singleLine) return '';
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function toolDisplayName(capabilityId: string): string {
  const known = TOOL_DISPLAY_NAMES[capabilityId] ?? TOOL_DISPLAY_NAMES[capabilityId.toLowerCase()];
  if (known) return known;
  const leaf = capabilityId.split('.').filter(Boolean).at(-1) ?? capabilityId;
  if (!leaf) return 'Tool';
  // Prefer kind-style labels for common leaf names even when casing differs.
  const knownLeaf = TOOL_DISPLAY_NAMES[leaf] ?? TOOL_DISPLAY_NAMES[leaf.toLowerCase()];
  if (knownLeaf) return knownLeaf;
  return leaf.charAt(0).toUpperCase() + leaf.slice(1);
}

export function toolArgumentSummary(
  capabilityId: string,
  args: Record<string, unknown> | null | undefined,
): string {
  const record = args ?? {};
  if (
    capabilityId === 'local.interaction.request_user_input'
    || capabilityId === 'request_user_input'
  ) {
    const question = typeof record.question === 'string' ? record.question : '';
    return compactText(question, 88);
  }
  if (capabilityId === 'local.shell.exec') {
    const command = typeof record.command === 'string' ? record.command : '';
    return compactText(command, 88);
  }
  if (
    capabilityId === 'local.file.read'
    || capabilityId === 'local.file.write'
    || capabilityId === 'local.file.list'
  ) {
    const path = typeof record.path === 'string'
      ? record.path
      : typeof record.file === 'string'
        ? record.file
        : '';
    return compactText(path, 88);
  }
  if (
    capabilityId === 'local.search.content'
    || capabilityId === 'local.search.files'
    || capabilityId === 'local.search.aggregate'
  ) {
    const query = typeof record.query === 'string'
      ? record.query
      : typeof record.pattern === 'string'
        ? record.pattern
        : '';
    return compactText(query, 72);
  }

  const preferred = ['path', 'command', 'query', 'url', 'name', 'id']
    .map((key) => record[key])
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  if (preferred) return compactText(preferred, 72);

  const keys = Object.keys(record);
  if (keys.length === 0) return '';
  return compactText(keys.slice(0, 3).join(', '), 48);
}

export function normalizeToolPresentationStatus(value: unknown): ToolPresentationStatus {
  switch (value) {
    case 'completed':
    case 'failed':
    case 'cancelled':
    case 'denied':
    case 'running':
      return value;
    default:
      return 'unknown';
  }
}

export function toolStatusGlyph(status: ToolPresentationStatus): string {
  switch (status) {
    case 'failed':
    case 'denied':
      return TOOL_CHROME.glyphFailed;
    case 'cancelled':
      return TOOL_CHROME.glyphCancelled;
    case 'running':
      return TOOL_CHROME.glyphRunning;
    case 'completed':
      return TOOL_CHROME.glyphCompleted;
    case 'unknown':
    default:
      return TOOL_CHROME.glyphUnknown;
  }
}

// Prefer geometric/line glyphs over Braille: Braille dots sit high in many terminal
// fonts and look misaligned next to CJK/Latin status labels like "运行中…".
const THINKING_CURSOR_FRAMES = ['|', '/', '-', '\\'] as const;

/** Single spinner glyph used by composer running status. */
export function thinkingSpinnerGlyph(frame: number): string {
  return THINKING_CURSOR_FRAMES[Math.abs(frame) % THINKING_CURSOR_FRAMES.length] ?? '|';
}

const THINKING_DOT_FRAMES = ['.', '..', '...'] as const;

/** Trailing three-dot animation for pending assistant placeholders (no leading spinner). */
export function thinkingStatusLabel(frame: number, _hasThinkingContent = false): string {
  const dots = THINKING_DOT_FRAMES[Math.abs(frame) % THINKING_DOT_FRAMES.length] ?? '.';
  return `Thinking${dots}`;
}

const RUNNING_ACTIVITY_GLYPHS = '0123456789abcdefABCDEF~!@#$%^&*+=_';

/** A deterministic, continuously changing Crush-style character field. */
export function runningActivityField(frame: number, width = 80): string {
  const length = width >= 48 ? 12 : width >= 30 ? 8 : 4;
  return Array.from({ length }, (_, index) => {
    const offset = Math.abs(frame * 11 + index * 17 + index * index * 3);
    return RUNNING_ACTIVITY_GLYPHS[offset % RUNNING_ACTIVITY_GLYPHS.length] ?? '0';
  }).join('');
}

export function formatRunningElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Character field + stable real status + elapsed time, with narrow-width fallback. */
export function composerRunningStatusLine(options: {
  readonly frame: number;
  readonly statusLabel: string;
  readonly elapsedMs?: number;
  readonly width?: number;
}): string {
  const width = options.width ?? 80;
  const activity = runningActivityField(options.frame, width);
  const elapsed = formatRunningElapsed(options.elapsedMs ?? 0);
  const label = options.statusLabel.trim();
  // Empty label (generic running) keeps the Crush-style activity field + timer.
  if (width < 30 || !label) return `${activity} · ${elapsed}`;
  return `${activity}  ${label} · ${elapsed}`;
}

/** Breathing/pulsing leading glyph for in-flight tool rows. */
export function runningToolStatusGlyph(frame: number): string {
  const frames = TOOL_CHROME.runningFrames;
  return frames[Math.abs(frame) % frames.length] ?? TOOL_CHROME.glyphRunning;
}

/** Prefer animated glyph only while status is running. */
export function animatedToolStatusGlyph(status: ToolPresentationStatus, frame = 0): string {
  if (status === 'running') return runningToolStatusGlyph(frame);
  return toolStatusGlyph(status);
}


export function toolHeadline(
  toolName: string,
  argumentSummary: string,
): string {
  if (!argumentSummary) return toolName;
  return `${toolName}(${argumentSummary})`;
}

export function toolDetailLines(
  detail: string,
  maxLines = DEFAULT_DETAIL_PREVIEW_LINES,
  lineMax = DEFAULT_DETAIL_LINE_MAX,
): readonly string[] {
  const lines = detail
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .map((line) => compactText(line, lineMax));
  if (lines.length === 0) return ['completed'];
  if (lines.length <= maxLines) return lines;
  const visible = lines.slice(0, maxLines);
  const remaining = lines.length - maxLines;
  return [...visible, `… +${remaining} lines`];
}

export function createToolPresentation(input: {
  readonly capabilityId: string;
  readonly arguments?: Record<string, unknown> | null;
  readonly status?: unknown;
  readonly outputPreview?: unknown;
  readonly errorMessage?: string | null;
  readonly toolCallId?: string | null;
  readonly startedAt?: number;
  readonly completedAt?: number;
}): ToolPresentation {
  const capabilityId = input.capabilityId.trim() || 'tool';
  const status = normalizeToolPresentationStatus(input.status);
  const toolName = toolDisplayName(capabilityId);
  const argumentSummary = toolArgumentSummary(capabilityId, input.arguments);
  const fallback = status === 'failed' || status === 'denied'
    ? (input.errorMessage?.trim() || status)
    : status === 'cancelled'
      ? 'cancelled'
      : 'completed';
  const interactionDetail = formatInteractionToolDetail(
    input.outputPreview,
    input.arguments,
  ) ?? (
    isRequestUserInputTool(capabilityId)
      ? formatInteractionToolDetail(input.arguments, input.arguments)
      : null
  );
  const detail = interactionDetail
    ?? formatToolResultSummary(input.outputPreview, fallback);
  const toolCallId = typeof input.toolCallId === 'string' && input.toolCallId.trim()
    ? input.toolCallId.trim()
    : undefined;
  const startedAt = Number.isFinite(input.startedAt) ? input.startedAt : undefined;
  const completedAt = Number.isFinite(input.completedAt) ? input.completedAt : undefined;
  const durationMs = startedAt !== undefined && completedAt !== undefined
    ? Math.max(0, completedAt - startedAt)
    : undefined;
  return {
    capabilityId,
    toolName,
    argumentSummary,
    status,
    detail,
    detailLines: toolDetailLines(detail),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(toolCallId ? { toolCallId } : {}),
    ...(input.arguments === undefined ? {} : { arguments: input.arguments }),
  };
}

/**
 * Best-effort recovery for older sessions that only stored a flat
 * `capabilityId: summary` string.
 */
export function parseLegacyToolContent(content: string): ToolPresentation {
  const trimmed = content.trim();
  const match = /^([a-z0-9._-]+):\s*([\s\S]*)$/i.exec(trimmed);
  if (!match) {
    return createToolPresentation({
      capabilityId: 'tool',
      status: 'unknown',
      outputPreview: trimmed || 'completed',
    });
  }
  return createToolPresentation({
    capabilityId: match[1]!,
    status: 'unknown',
    outputPreview: match[2] || 'completed',
  });
}

export function resolveToolPresentation(
  message: {
    readonly content: string;
    readonly tool?: Partial<ToolPresentation> | null;
  },
): ToolPresentation {
  const tool = message.tool;
  if (tool && typeof tool.capabilityId === 'string' && tool.capabilityId.trim()) {
    const detail = typeof tool.detail === 'string' && tool.detail.trim()
      ? tool.detail
      : message.content;
    const status = normalizeToolPresentationStatus(tool.status);
    const toolName = typeof tool.toolName === 'string' && tool.toolName.trim()
      ? tool.toolName
      : toolDisplayName(tool.capabilityId);
    const arguments_ = tool.arguments && typeof tool.arguments === 'object' && !Array.isArray(tool.arguments)
      ? tool.arguments
      : tool.arguments === null
        ? null
        : undefined;
    const storedSummary = typeof tool.argumentSummary === 'string'
      ? compactText(tool.argumentSummary, 88)
      : '';
    const argumentSummary = storedSummary || toolArgumentSummary(tool.capabilityId, arguments_);
    const startedAt = typeof tool.startedAt === 'number' && Number.isFinite(tool.startedAt)
      ? tool.startedAt
      : undefined;
    const completedAt = typeof tool.completedAt === 'number' && Number.isFinite(tool.completedAt)
      ? tool.completedAt
      : undefined;
    const storedDuration = typeof tool.durationMs === 'number' && Number.isFinite(tool.durationMs)
      ? Math.max(0, tool.durationMs)
      : undefined;
    const durationMs = storedDuration ?? (
      startedAt !== undefined && completedAt !== undefined
        ? Math.max(0, completedAt - startedAt)
        : undefined
    );
    const toolCallId = typeof tool.toolCallId === 'string' && tool.toolCallId.trim()
      ? tool.toolCallId.trim()
      : undefined;
    return {
      capabilityId: tool.capabilityId,
      toolName,
      argumentSummary,
      status,
      detail,
      detailLines: Array.isArray(tool.detailLines) && tool.detailLines.length > 0
        ? tool.detailLines
        : toolDetailLines(detail),
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(completedAt === undefined ? {} : { completedAt }),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(toolCallId ? { toolCallId } : {}),
      ...(arguments_ === undefined ? {} : { arguments: arguments_ }),
    };
  }
  return parseLegacyToolContent(message.content);
}

export function toolActivitySummary(presentation: ToolPresentation, maxLength = 108): string {
  const argumentSummary = compactText(presentation.argumentSummary, maxLength);
  if (argumentSummary) return argumentSummary;

  const argumentsSummary = toolArgumentSummary(presentation.capabilityId, presentation.arguments);
  if (argumentsSummary) return compactText(argumentsSummary, maxLength);

  if (presentation.capabilityId === 'local.shell.exec') {
    try {
      const parsed = JSON.parse(presentation.detail) as unknown;
      const record = asRecord(parsed);
      const command = typeof record?.command === 'string' ? record.command : '';
      if (command) return compactText(command, maxLength);
    } catch {
      // Older shell records may not contain JSON; use the generic one-line fallback below.
    }
  }

  return toolResultInlineSummary(presentation.detail, maxLength);
}

export function isGoalStatusToolPresentation(presentation: ToolPresentation): boolean {
  return GOAL_STATUS_CAPABILITY_IDS.has(
    canonicalizeLocalCapabilityId(presentation.capabilityId),
  ) || new Set<string>([
    SHARED_LOCAL_TOOL_CONTRACTS.goalCreatePlan.toolName,
    SHARED_LOCAL_TOOL_CONTRACTS.goalUpdateTask.toolName,
    SHARED_LOCAL_TOOL_CONTRACTS.goalGetPlan.toolName,
  ]).has(presentation.toolName);
}

export function scrambleStatusLabel(label: string, frame: number, revealFrames = 6): string {
  if (frame >= revealFrames) return label;
  const glyphs = '▓▒░<>/\\[]{}';
  const revealCount = Math.floor((Math.max(0, frame) / revealFrames) * label.length);
  return [...label].map((character, index) => {
    if (/\s/u.test(character) || index < revealCount) return character;
    return glyphs[(frame * 7 + index * 3) % glyphs.length];
  }).join('');
}

export function formatToolDuration(presentation: Pick<ToolPresentation, 'status' | 'durationMs'>): string {
  if (presentation.status === 'running') return 'now';
  if (presentation.durationMs === undefined) return '—';
  if (presentation.durationMs < 1_000) return `${Math.max(0.1, presentation.durationMs / 1_000).toFixed(1)}s`;
  if (presentation.durationMs < 10_000) return `${(presentation.durationMs / 1_000).toFixed(1)}s`;
  return `${Math.round(presentation.durationMs / 1_000)}s`;
}

export function toolPresentationContent(presentation: ToolPresentation): string {
  const headline = toolHeadline(presentation.toolName, presentation.argumentSummary);
  return `${presentation.capabilityId}: ${headline} — ${presentation.detail}`;
}
