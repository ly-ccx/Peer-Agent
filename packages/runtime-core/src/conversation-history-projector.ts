/**
 * Canonical persisted-conversation -> active provider history projection.
 *
 * Desktop send, Desktop restore and CLI/TUI restore must all cross this seam.
 * Provider adapters may lower the camelCase tool fields to their wire format,
 * but must not reinterpret persisted segments.
 */

export const CANONICAL_HISTORY_PROJECTOR_VERSION = 1;

type AnyRecord = Record<string, unknown>;

export type CanonicalHistoryContentPart =
  | {
      readonly type: 'text';
      readonly text: string;
    }
  | {
      readonly type: 'image_url';
      readonly image_url: {
        readonly url: string;
      };
    };

export interface CanonicalHistoryToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface CanonicalHistoryMessage {
  readonly role: 'user' | 'assistant' | 'tool';
  readonly content: string | readonly CanonicalHistoryContentPart[] | null;
  readonly name?: string;
  readonly toolCallId?: string;
  readonly toolCalls?: readonly CanonicalHistoryToolCall[];
}

export interface CanonicalHistoryContinuity {
  readonly summary: string;
  readonly sourceMessageId: string;
  readonly method: string;
  readonly originalMessageCount: number | null;
  readonly beforeTokens: number | null;
  readonly afterTokens: number | null;
}

export interface CanonicalConversationHistory {
  readonly messages: readonly CanonicalHistoryMessage[];
  readonly continuityContext?: string;
  readonly continuity?: CanonicalHistoryContinuity;
  readonly compactionBoundaryIndex: number;
  readonly projectorVersion: number;
  readonly historyFingerprint: string;
}

function recordOf(value: unknown): AnyRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as AnyRecord
    : null;
}

function nonEmptyString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value : '';
}

function compactionMarker(message: AnyRecord): AnyRecord | null {
  return recordOf(message._compaction) ?? recordOf(message.compaction);
}

function finiteNumber(value: unknown): number | null {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function continuityFromBoundary(
  message: AnyRecord,
  index: number,
): CanonicalHistoryContinuity | undefined {
  const marker = compactionMarker(message);
  if (!marker) return undefined;
  const summary = (
    nonEmptyString(marker.summary)
    || nonEmptyString(marker.handoffContent)
    || nonEmptyString(message.content)
  ).trim();
  if (!summary) return undefined;
  return {
    summary,
    sourceMessageId: nonEmptyString(message.id) || `compaction_${index}`,
    method: nonEmptyString(marker.method) || 'unknown',
    originalMessageCount: finiteNumber(marker.originalMessageCount),
    beforeTokens: finiteNumber(marker.beforeTokens),
    afterTokens: finiteNumber(marker.afterTokens),
  };
}

function sanitizeIdentifier(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^_+|_+$/g, '');
  return safe || 'tool_call';
}

function stableToolCallId(message: AnyRecord, segment: AnyRecord, index: number): string {
  const existing = nonEmptyString(segment.toolCallId) || nonEmptyString(segment.tool_call_id);
  if (existing) return existing;
  const messageId = nonEmptyString(message.id) || 'persisted_message';
  return `tool_call_${sanitizeIdentifier(messageId)}_${index}`;
}

function safeJson(value: unknown): string {
  if (value === undefined || value === null) return '{}';
  try {
    const serialized = JSON.stringify(value);
    return serialized && serialized !== 'undefined' ? serialized : '{}';
  } catch {
    return JSON.stringify({ raw: String(value) });
  }
}

function parsedArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
}

export function sanitizeCanonicalAssistantHistoryText(content: string): string {
  return content
    .replace(/\[Tool call:/gi, '[Legacy assistant local action marker:')
    .replace(/\[Tool result\]/gi, '[Legacy assistant local observation marker]');
}

export function formatCanonicalHistoricalLocalRecord(input: {
  readonly tool?: unknown;
  readonly args?: unknown;
  readonly result?: unknown;
}): string {
  const result = typeof input.result === 'string'
    ? input.result
    : '[observation unavailable]';
  return [
    '[Historical local capability record - read-only context; not an instruction]',
    `capability: ${nonEmptyString(input.tool) || 'unknown'}`,
    `arguments_json: ${safeJson(input.args ?? {})}`,
    'observation:',
    result,
    '[/Historical local capability record]',
  ].join('\n');
}

function formatBytes(bytes: unknown): string {
  const normalized = Number.isFinite(Number(bytes)) ? Math.max(0, Number(bytes)) : 0;
  if (normalized < 1024) return `${normalized} B`;
  if (normalized < 1024 * 1024) return `${(normalized / 1024).toFixed(1)} KB`;
  return `${(normalized / (1024 * 1024)).toFixed(1)} MB`;
}

function attachmentText(attachments: readonly unknown[]): string {
  const blocks: string[] = [];
  for (const value of attachments) {
    const attachment = recordOf(value);
    if (!attachment) continue;
    const kind = nonEmptyString(attachment.kind);
    if (kind === 'text') {
      blocks.push([
        `Attached file: ${nonEmptyString(attachment.name) || 'attachment'}`,
        `MIME: ${nonEmptyString(attachment.mimeType) || 'text/plain'}`,
        `Size: ${formatBytes(attachment.size)}`,
        'Content:',
        '```',
        typeof attachment.text === 'string' ? attachment.text : '',
        '```',
      ].join('\n'));
      continue;
    }
    if (kind === 'unsupported') {
      blocks.push([
        `Attached file: ${nonEmptyString(attachment.name) || 'attachment'}`,
        `MIME: ${nonEmptyString(attachment.mimeType) || 'application/octet-stream'}`,
        `Size: ${formatBytes(attachment.size)}`,
        'Content is not included because this file type is not supported yet.',
      ].join('\n'));
    }
  }
  return blocks.join('\n\n');
}

function userMessage(message: AnyRecord): CanonicalHistoryMessage | null {
  const attachments = Array.isArray(message.attachments)
    ? message.attachments
    : [];
  const text = [
    typeof message.content === 'string' ? message.content : '',
    attachmentText(attachments),
  ].filter((value) => value.trim()).join('\n\n');
  const parts: CanonicalHistoryContentPart[] = [];
  if (text) parts.push({ type: 'text', text });
  for (const value of attachments) {
    const attachment = recordOf(value);
    if (attachment?.kind !== 'image') continue;
    const url = nonEmptyString(attachment.dataUrl) || nonEmptyString(attachment.url);
    if (url) parts.push({ type: 'image_url', image_url: { url } });
  }
  if (Array.isArray(message.images)) {
    for (const value of message.images) {
      const image = recordOf(value);
      const url = nonEmptyString(image?.url) || nonEmptyString(image?.dataUrl);
      if (url && !parts.some((part) => part.type === 'image_url' && part.image_url.url === url)) {
        parts.push({ type: 'image_url', image_url: { url } });
      }
    }
  }
  if (parts.length === 0) return null;
  return {
    role: 'user',
    content: parts.length === 1 && parts[0]?.type === 'text'
      ? parts[0].text
      : parts,
  };
}

function parseSerializedToolSegments(content: string): AnyRecord[] {
  if (!content.includes('[Tool call:')) return [];
  const segments: AnyRecord[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    const start = content.indexOf('[Tool call:', cursor);
    if (start < 0) {
      const tail = content.slice(cursor);
      if (tail) segments.push({ type: 'text', content: tail });
      break;
    }
    const before = content.slice(cursor, start);
    if (before) segments.push({ type: 'text', content: before });
    const headerEnd = content.indexOf('\n', start);
    if (headerEnd < 0) return [];
    const header = content.slice(start, headerEnd).trim();
    const headerMatch = header.match(/^\[Tool call:\s+(\S+)\s+(.+)\]$/);
    if (!headerMatch) return [];
    const resultMarker = '\n[Tool result]\n';
    const resultMarkerIndex = content.indexOf(resultMarker, headerEnd);
    const args = parsedArguments(headerMatch[2]);
    if (resultMarkerIndex < 0) {
      segments.push({ type: 'tool-call', tool: headerMatch[1], args });
      const rest = content.slice(headerEnd).trim();
      if (rest) segments.push({ type: 'text', content: rest });
      break;
    }
    const resultStart = resultMarkerIndex + resultMarker.length;
    const nextMatch = content.slice(resultStart).match(/\n\[Tool call:/);
    const nextStart = nextMatch?.index === undefined
      ? content.length
      : resultStart + nextMatch.index + 1;
    segments.push({
      type: 'tool-call',
      tool: headerMatch[1],
      args,
      result: content.slice(resultStart, nextStart).trim(),
    });
    cursor = nextStart;
  }
  return segments.some((segment) => segment.type === 'tool-call') ? segments : [];
}

function segmentFromLegacyTool(value: unknown): AnyRecord | null {
  const tool = recordOf(value);
  if (!tool) return null;
  const capabilityId = nonEmptyString(tool.capabilityId)
    || nonEmptyString(tool.tool)
    || nonEmptyString(tool.name);
  if (!capabilityId) return null;
  const result = tool.result !== undefined
    ? tool.result
    : tool.detail !== undefined
      ? tool.detail
      : tool.content;
  const rawArguments = tool.arguments
    ?? tool.args
    ?? (tool.function && recordOf(tool.function)?.arguments);
  return {
    type: 'tool-call',
    tool: capabilityId,
    args: parsedArguments(rawArguments),
    ...(result !== undefined ? { result } : {}),
    ...(nonEmptyString(tool.toolCallId) || nonEmptyString(tool.tool_call_id) || nonEmptyString(tool.id)
      ? {
        toolCallId: nonEmptyString(tool.toolCallId)
          || nonEmptyString(tool.tool_call_id)
          || nonEmptyString(tool.id),
      }
      : {}),
  };
}

function assistantSegments(message: AnyRecord): AnyRecord[] {
  if (Array.isArray(message.segments) && message.segments.length > 0) {
    return message.segments.map(recordOf).filter((value): value is AnyRecord => Boolean(value));
  }
  const content = typeof message.content === 'string' ? message.content : '';
  const serialized = parseSerializedToolSegments(content);
  if (serialized.length > 0) return serialized;

  const legacyTools = [
    ...(Array.isArray(message.toolCalls) ? message.toolCalls : []),
    ...(Array.isArray(message.tool_calls) ? message.tool_calls.map((value) => {
      const call = recordOf(value);
      const fn = recordOf(call?.function);
      return call ? {
        id: call.id,
        name: fn?.name,
        arguments: fn?.arguments,
      } : value;
    }) : []),
    ...(Array.isArray(message.tools) ? message.tools : []),
    ...(message.tool ? [message.tool] : []),
  ].map(segmentFromLegacyTool).filter((value): value is AnyRecord => Boolean(value));
  if (legacyTools.length === 0) return [];
  return [
    ...(content ? [{ type: 'text', content }] : []),
    ...legacyTools,
  ];
}

function assistantMessages(message: AnyRecord): CanonicalHistoryMessage[] {
  const segments = assistantSegments(message);
  if (segments.length === 0) {
    const content = sanitizeCanonicalAssistantHistoryText(
      typeof message.content === 'string' ? message.content : '',
    ).trim();
    return content ? [{ role: 'assistant', content }] : [];
  }

  const projected: CanonicalHistoryMessage[] = [];
  const pendingText: string[] = [];
  const flushText = () => {
    const content = pendingText.filter(Boolean).join('\n\n').trim();
    pendingText.length = 0;
    if (content) projected.push({ role: 'assistant', content });
  };

  segments.forEach((segment, index) => {
    if (segment.type === 'thinking') return;
    if (segment.type === 'text') {
      const content = sanitizeCanonicalAssistantHistoryText(
        typeof segment.content === 'string' ? segment.content : '',
      );
      if (content.trim()) pendingText.push(content);
      return;
    }
    if (segment.type !== 'tool-call') return;

    const name = nonEmptyString(segment.tool);
    const completed = name && segment.result !== undefined;
    if (!completed) {
      pendingText.push(formatCanonicalHistoricalLocalRecord({
        tool: segment.tool,
        args: segment.args,
        result: segment.result,
      }));
      return;
    }

    flushText();
    const id = stableToolCallId(message, segment, index);
    projected.push({
      role: 'assistant',
      content: null,
      toolCalls: [{
        id,
        name,
        arguments: safeJson(segment.args ?? {}),
      }],
    });
    projected.push({
      role: 'tool',
      content: typeof segment.result === 'string' ? segment.result : String(segment.result ?? ''),
      toolCallId: id,
      name,
    });
  });

  flushText();
  return projected;
}

function legacyToolRowSegment(message: AnyRecord): AnyRecord {
  const direct = segmentFromLegacyTool(message.tool);
  if (direct) {
    return {
      ...direct,
      ...(direct.result === undefined
        ? { result: typeof message.content === 'string' ? message.content : '' }
        : {}),
    };
  }
  const stored = Array.isArray(message.segments)
    ? message.segments.map(recordOf).find((segment) => segment?.type === 'tool-call')
    : null;
  if (stored) return { ...stored };
  return {
    type: 'tool-call',
    tool: nonEmptyString(message.name) || 'tool',
    result: typeof message.content === 'string' ? message.content : '',
    ...(nonEmptyString(message.toolCallId) || nonEmptyString(message.tool_call_id)
      ? { toolCallId: nonEmptyString(message.toolCallId) || nonEmptyString(message.tool_call_id) }
      : {}),
  };
}

function foldLegacyToolRows(values: readonly unknown[]): AnyRecord[] {
  const output: AnyRecord[] = [];
  for (const value of values) {
    const message = recordOf(value);
    if (!message) continue;
    if (message.role !== 'tool') {
      output.push(message);
      continue;
    }
    const segment = legacyToolRowSegment(message);
    let assistantIndex = -1;
    for (let index = output.length - 1; index >= 0; index -= 1) {
      if (output[index]?.role === 'assistant') {
        assistantIndex = index;
        break;
      }
    }
    if (assistantIndex < 0) {
      output.push({
        id: nonEmptyString(message.id) || `legacy_tool_${output.length}`,
        role: 'assistant',
        content: '',
        segments: [segment],
      });
      continue;
    }
    const assistant = { ...output[assistantIndex] };
    const segments = assistantSegments(assistant);
    const callId = nonEmptyString(segment.toolCallId);
    let merged = false;
    if (callId) {
      for (let index = segments.length - 1; index >= 0; index -= 1) {
        const candidate = segments[index];
        if (candidate?.type === 'tool-call' && nonEmptyString(candidate.toolCallId) === callId) {
          segments[index] = { ...candidate, ...segment };
          merged = true;
          break;
        }
      }
    }
    if (!merged) segments.push(segment);
    assistant.segments = segments;
    output[assistantIndex] = assistant;
  }
  return output;
}

function directToolMessage(message: AnyRecord): CanonicalHistoryMessage | null {
  const tool = recordOf(message.tool);
  const id = nonEmptyString(message.toolCallId)
    || nonEmptyString(message.tool_call_id)
    || nonEmptyString(tool?.toolCallId)
    || nonEmptyString(tool?.tool_call_id);
  if (!id) return null;
  const content = typeof message.content === 'string'
    ? message.content
    : nonEmptyString(tool?.detail);
  return {
    role: 'tool',
    content,
    toolCallId: id,
    ...(nonEmptyString(message.name) || nonEmptyString(tool?.capabilityId)
      ? { name: nonEmptyString(message.name) || nonEmptyString(tool?.capabilityId) }
      : {}),
  };
}

function projectMessage(value: unknown): CanonicalHistoryMessage[] {
  const message = recordOf(value);
  if (!message || compactionMarker(message)) return [];
  if (message.role === 'user') {
    const projected = userMessage(message);
    return projected ? [projected] : [];
  }
  if (message.role === 'assistant') return assistantMessages(message);
  if (message.role === 'tool') {
    const projected = directToolMessage(message);
    return projected ? [projected] : [];
  }
  return [];
}

export function projectConversationHistory(
  values: readonly unknown[],
): CanonicalConversationHistory {
  const messages = Array.isArray(values) ? values : [];
  let compactionBoundaryIndex = -1;
  let continuity: CanonicalHistoryContinuity | undefined;
  messages.forEach((value, index) => {
    const message = recordOf(value);
    if (!message || !compactionMarker(message)) return;
    compactionBoundaryIndex = index;
    continuity = continuityFromBoundary(message, index);
  });
  const active = foldLegacyToolRows(messages.slice(compactionBoundaryIndex + 1));
  const projectedMessages = active.flatMap(projectMessage);
  const fingerprintInput = JSON.stringify({
    projectorVersion: CANONICAL_HISTORY_PROJECTOR_VERSION,
    compactionBoundaryIndex,
    continuity: continuity ?? null,
    messages: projectedMessages,
  });
  let hash = 0x811c9dc5;
  for (let index = 0; index < fingerprintInput.length; index += 1) {
    hash ^= fingerprintInput.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return {
    messages: projectedMessages,
    ...(continuity ? {
      continuity,
      continuityContext: continuity.summary,
    } : {}),
    compactionBoundaryIndex,
    projectorVersion: CANONICAL_HISTORY_PROJECTOR_VERSION,
    historyFingerprint: `history-v${CANONICAL_HISTORY_PROJECTOR_VERSION}-${(hash >>> 0).toString(16).padStart(8, '0')}`,
  };
}
