import { collectToolEvidenceRefs } from '@peer-agent/runtime-core';

import {
  materializeToolResultContent,
  type MaterializedToolResult,
} from './tool-artifact-store.ts';

/** Working-set file reads stay inline. Matches write_file's 32KB payload cap. */
export const FILE_READ_INLINE_MAX_CHARS = 32_000;
/** Process / test stdout preview. Full stream stays on the shell artifact. */
export const SHELL_CONTEXT_PREVIEW_CHARS = 4_000;

const LOCAL_REF_KINDS = new Set([
  'local_tool_result_ref',
  'local_file_ref',
  'local_capability_result_ref',
]);

export interface EncodeProviderToolResultInput {
  readonly result?: {
    readonly status?: string;
    readonly toolCallId?: string;
    readonly output?: unknown;
    readonly outputPreview?: unknown;
    readonly error?: unknown;
  } | null;
  readonly execution?: unknown;
  readonly conversationId?: string | null;
  readonly toolCallId?: string | null;
  readonly tool?: string | null;
  readonly evidenceRefs?: readonly string[];
  readonly baseDir?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function isLocalRef(record: Record<string, unknown> | null): record is Record<string, unknown> {
  return Boolean(record && LOCAL_REF_KINDS.has(String(record.kind ?? '')));
}

function quoteShellPath(filePath: string): string {
  return `"${filePath.replace(/(["\\$`])/g, '\\$1')}"`;
}

function clipPreview(content: string, maxChars: number): { preview: string; truncated: boolean } {
  if (content.length <= maxChars) return { preview: content, truncated: false };
  const headChars = Math.max(1_000, Math.floor(maxChars * 0.55));
  const tailChars = Math.max(800, maxChars - headChars - 80);
  return {
    preview: `${content.slice(0, headChars)}\n...[context preview truncated: ${content.length} chars]...\n${content.slice(-tailChars)}`,
    truncated: true,
  };
}

function isFileReadOutput(record: Record<string, unknown> | null): record is Record<string, unknown> & {
  path: string;
  content: string;
} {
  return Boolean(
    record
    && typeof record.path === 'string'
    && record.path.trim()
    && typeof record.content === 'string'
    && (typeof record.bytes === 'number' || typeof record.contentHash === 'string'),
  );
}

function isShellOutput(record: Record<string, unknown> | null): boolean {
  return Boolean(
    record
    && typeof record.stdout === 'string'
    && (
      typeof record.artifactRef === 'string'
      || typeof record.taskId === 'string'
      || typeof record.command === 'string'
    ),
  );
}

function encodeFileRead(
  output: Record<string, unknown> & { path: string; content: string },
  evidenceRefs: readonly string[],
): Record<string, unknown> {
  const clipped = clipPreview(output.content, FILE_READ_INLINE_MAX_CHARS);
  return {
    kind: 'local_file_ref',
    tool: 'read_file',
    path: output.path,
    chars: output.content.length,
    ...(typeof output.bytes === 'number' ? { bytes: output.bytes } : {}),
    ...(typeof output.contentHash === 'string' ? { contentHash: output.contentHash } : {}),
    preview: clipped.preview,
    contextPreviewTruncated: clipped.truncated,
    suggestedRetrieval: [
      `sed -n '1,160p' ${quoteShellPath(output.path)}`,
    ],
    note: clipped.truncated
      ? 'Preview only. Use read_file or sed on the workspace path for the omitted middle. Do not read Peer internal tool-tui-tool artifacts.'
      : 'Full file is inline. Do not recover this by reading Peer internal artifacts.',
    ...(evidenceRefs.length > 0 ? { evidenceRefs: [...evidenceRefs] } : {}),
  };
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function encodeShell(
  output: Record<string, unknown> | null,
  outputPreview: Record<string, unknown> | null,
  evidenceRefs: readonly string[],
): Record<string, unknown> {
  const fullStdout = typeof output?.stdout === 'string' ? output.stdout : '';
  const previewSource = typeof outputPreview?.stdout === 'string' ? outputPreview : output;
  const stdoutPreview = String(previewSource?.stdout ?? '').slice(0, SHELL_CONTEXT_PREVIEW_CHARS);
  const stdoutPath = firstString(output?.stdoutPath, outputPreview?.stdoutPath);
  const artifactRef = firstString(output?.artifactRef, outputPreview?.artifactRef);
  const artifactRefs = [
    ...(Array.isArray(output?.artifactRefs) ? output.artifactRefs : []),
    ...(Array.isArray(outputPreview?.artifactRefs) ? outputPreview.artifactRefs : []),
  ].filter((item): item is string => typeof item === 'string' && Boolean(item.trim()));
  const truncated = fullStdout.length > SHELL_CONTEXT_PREVIEW_CHARS
    || previewSource?.truncated === true
    || outputPreview?.contextPreviewTruncated === true;
  const suggestedRetrieval = stdoutPath
    ? [
        `rg -n "FAIL|Error|error|failed" ${quoteShellPath(stdoutPath)}`,
        `tail -n 120 ${quoteShellPath(stdoutPath)}`,
      ]
    : [];
  return {
    kind: 'local_tool_result_ref',
    tool: 'bash',
    command: firstString(output?.command, outputPreview?.command),
    cwd: firstString(output?.cwd, outputPreview?.cwd),
    exitCode: output?.exitCode ?? outputPreview?.exitCode ?? null,
    status: firstString(output?.status, outputPreview?.status) ?? 'completed',
    artifactRef,
    ...(artifactRefs.length > 0 ? { artifactRefs: [...new Set(artifactRefs)] } : {}),
    ...(stdoutPath ? { stdoutPath } : {}),
    ...(fullStdout ? { stdoutChars: fullStdout.length } : {}),
    stdoutPreview,
    contextPreviewTruncated: truncated,
    ...(suggestedRetrieval.length > 0 ? { suggestedRetrieval } : {}),
    note: truncated
      ? 'Stdout preview only. Full stream is on the shell artifact (artifactRefs / stdoutPath). Do not read ~/.peer-agent/artifacts/**/tool-tui-tool-*.txt. To reread a source file, use read_file on the workspace path.'
      : 'Do not recover this output by reading Peer internal tool-tui-tool artifacts.',
    ...(evidenceRefs.length > 0 ? { evidenceRefs: [...evidenceRefs] } : {}),
  };
}

/**
 * Encode one tool result for provider history.
 *
 * Working-set file reads stay inline (up to FILE_READ_INLINE_MAX_CHARS).
 * Shell logs keep a short preview and point at the shell artifact, not a
 * second JSON dump under ~/.peer-agent/artifacts/tool-tui-tool-*.
 * Already-structured local_*_ref payloads are passed through.
 * Unstructured leftovers still go through Layer 0 materialization.
 */
export function encodeProviderToolResult(
  input: EncodeProviderToolResultInput = {},
): MaterializedToolResult {
  const result = input.result ?? {};
  const outputRecord = asRecord(result.output);
  const previewRecord = asRecord(result.outputPreview);
  const toolCallId = input.toolCallId ?? (typeof result.toolCallId === 'string' ? result.toolCallId : null);
  const evidenceRefs = input.evidenceRefs ?? collectToolEvidenceRefs({
    toolCallId: toolCallId ?? undefined,
    execution: input.execution ?? { result },
  });
  const materialize = (content: string, inlineMaxChars?: number) => materializeToolResultContent({
    conversationId: input.conversationId,
    toolCallId,
    tool: input.tool,
    content,
    isError: result.status === 'failed',
    baseDir: input.baseDir,
    ...(inlineMaxChars ? { inlineMaxChars } : {}),
  });

  const existingRef = isLocalRef(outputRecord)
    ? outputRecord
    : isLocalRef(previewRecord)
      ? previewRecord
      : null;
  if (existingRef) {
    return materialize(JSON.stringify(existingRef));
  }

  if (isFileReadOutput(outputRecord)) {
    return materialize(JSON.stringify(encodeFileRead(outputRecord, evidenceRefs)));
  }

  if (isShellOutput(outputRecord) || isShellOutput(previewRecord)) {
    return materialize(JSON.stringify(encodeShell(outputRecord, previewRecord, evidenceRefs)));
  }

  const view: Record<string, unknown> = {
    ...(result.status ? { status: result.status } : {}),
    ...(result.output === undefined ? {} : { output: result.output }),
    ...(result.error === undefined ? {} : { error: result.error }),
    ...(evidenceRefs.length > 0 ? { evidenceRefs: [...evidenceRefs] } : {}),
  };
  return materialize(JSON.stringify(view));
}
