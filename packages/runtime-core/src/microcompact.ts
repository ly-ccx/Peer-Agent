// Layer 1 microcompaction — host-neutral (Desktop + CLI/TUI share one implementation).
//
// 从 Desktop context-compactor.mjs 平移下沉(23 号治理文档阶段 E):
// 对「最近窗口之外」的历史工具结果做证据引用化/预览化,而不是让大全文进 provider 请求。
// 结构化 ref(local_tool_result_ref / local_file_ref / local_capability_result_ref)
// 保留骨架与检索路径;无结构的长文本抽取可回捞线索(artifact/path/retrieval)后再预览化。
//
// 原则(17 号文档):It moves evidence out of prompt and keeps the route back.

export const MICROCOMPACTION_CONFIG = Object.freeze({
  keepRecentCount: 8,
  triggerChars: 6_000,
  previewChars: 800,
});

type AnyRecord = Record<string, unknown>;

/** 宽松消息形状:兼容 Desktop apiMessages 与 TUI ModelMessage(无索引签名接口)。 */
export type MicrocompactMessage = {
  readonly role?: string;
  readonly content?: unknown;
  readonly _compaction?: unknown;
};

export interface MicrocompactStats {
  readonly compactedCount: number;
  readonly beforeChars: number;
  readonly afterChars: number;
  readonly savedChars: number;
}

export interface MicrocompactResult<TMessage> {
  readonly messages: readonly TMessage[];
  readonly stats: MicrocompactStats;
}

export function previewHistoricalText(
  text: unknown,
  maxChars: number = MICROCOMPACTION_CONFIG.previewChars,
): string {
  const value = String(text ?? '');
  if (value.length <= maxChars) return value;
  const headChars = Math.max(200, Math.floor(maxChars * 0.55));
  const tailChars = Math.max(160, maxChars - headChars - 80);
  return `${value.slice(0, headChars)}\n...[historical context preview truncated: ${value.length} chars]...\n${value.slice(-tailChars)}`;
}

function tryParseJsonObject(text: unknown): AnyRecord | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as AnyRecord : null;
  } catch {
    return null;
  }
}

function pickDefined(source: AnyRecord | null | undefined, fields: readonly string[]): AnyRecord {
  const result: AnyRecord = {};
  for (const field of fields) {
    if (source?.[field] !== undefined) result[field] = source[field];
  }
  return result;
}

function compactLocalRefPayload(payload: AnyRecord | null, previewChars: number): AnyRecord | null {
  if (payload?.kind === 'local_tool_result_ref') {
    const compacted: AnyRecord = {
      kind: payload.kind,
      microCompacted: true,
      note: 'Historical local tool result compacted; use artifact paths or suggestedRetrieval for full output.',
      ...pickDefined(payload, [
        'tool', 'command', 'cwd', 'status', 'exitCode',
        'stdoutPath', 'stderrPath', 'metadataPath',
        'artifactRef', 'artifactRefs',
        'stdoutChars', 'stderrChars', 'stdoutLines', 'stderrLines',
        'originalChars', 'originalLines', 'keyFindings',
        'contextPreviewTruncated', 'suggestedRetrieval',
      ]),
    };
    if (payload.stdoutPreview) {
      compacted.stdoutPreview = previewHistoricalText(payload.stdoutPreview, previewChars);
    }
    if (payload.stderrPreview) {
      compacted.stderrPreview = previewHistoricalText(payload.stderrPreview, Math.min(previewChars, 400));
    }
    return compacted;
  }

  if (payload?.kind === 'local_file_ref') {
    return {
      kind: payload.kind,
      microCompacted: true,
      note: 'Historical local file read compacted; use path or suggestedRetrieval for full content.',
      ...pickDefined(payload, [
        'tool', 'path', 'chars', 'lines', 'mtimeMs', 'sizeBytes',
        'contentHash', 'fullRead', 'contextPreviewTruncated', 'suggestedRetrieval',
      ]),
      preview: previewHistoricalText((payload as AnyRecord).preview ?? '', previewChars),
    };
  }

  if (payload?.kind === 'local_capability_result_ref') {
    const outputPreview = payload.outputPreview && typeof payload.outputPreview === 'object'
      ? compactCapabilityOutputPreview(payload.outputPreview as AnyRecord, previewChars)
      : payload.outputPreview;
    return {
      kind: payload.kind,
      microCompacted: true,
      note: 'Historical local capability result compacted; use artifact paths or suggestedRetrieval for full output.',
      ...pickDefined(payload, [
        'tool', 'capabilityId', 'status', 'artifactRef', 'artifactRefs', 'suggestedRetrieval',
      ]),
      outputPreview,
    };
  }

  return null;
}

function compactCapabilityOutputPreview(preview: AnyRecord, previewChars: number): AnyRecord {
  const next: AnyRecord = {
    ...pickDefined(preview, [
      'status', 'tool', 'capabilityId', 'cwd', 'exitCode',
      'stdoutPath', 'stderrPath', 'metadataPath',
      'artifactRef', 'artifactRefs',
      'stdoutChars', 'stderrChars', 'stdoutLines', 'stderrLines',
      'contextPreviewTruncated', 'suggestedRetrieval',
    ]),
  };

  // nested shell/file refs inside capability output
  if (preview.localToolResultRef && typeof preview.localToolResultRef === 'object') {
    next.localToolResultRef = compactLocalRefPayload(
      { kind: 'local_tool_result_ref', ...(preview.localToolResultRef as AnyRecord) },
      previewChars,
    ) || {
      ...pickDefined(preview.localToolResultRef as AnyRecord, [
        'tool', 'command', 'cwd', 'status', 'exitCode',
        'stdoutPath', 'stderrPath', 'metadataPath',
        'artifactRef', 'artifactRefs', 'suggestedRetrieval',
      ]),
      microCompacted: true,
    };
  }

  if (typeof preview.preview === 'string') {
    next.preview = previewHistoricalText(preview.preview, previewChars);
  }
  if (typeof preview.stdoutPreview === 'string') {
    next.stdoutPreview = previewHistoricalText(preview.stdoutPreview, previewChars);
  }
  if (typeof preview.stderrPreview === 'string') {
    next.stderrPreview = previewHistoricalText(preview.stderrPreview, Math.min(previewChars, 400));
  }

  // Drop large unstructured blobs that are recoverable via artifact refs.
  if (preview.aggregated && typeof preview.aggregated === 'object') {
    next.aggregated = {
      ...pickDefined(preview.aggregated as AnyRecord, ['matchCount', 'truncated', 'laneCount']),
      note: 'Aggregated match details dropped by microcompact; use artifactRefs/suggestedRetrieval.',
    };
  }

  return next;
}

function uniqueNonEmptyStrings(values: readonly unknown[], limit = 12): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= limit) break;
  }
  return result;
}

/**
 * 从将被裁掉的历史正文中抽取可回捞线索（artifact / path / retrieval command）。
 * 目标：即使原文没有结构化 local_*_ref，压缩后仍留下可再读入口。
 */
export function extractRecoverableClues(
  text: unknown,
  { limit = 12 }: { limit?: number } = {},
): { artifactRefs: string[]; paths: string[]; suggestedRetrieval: string[] } {
  const value = String(text ?? '');
  if (!value) {
    return { artifactRefs: [], paths: [], suggestedRetrieval: [] };
  }

  const artifactRefs = uniqueNonEmptyStrings([
    ...(value.match(/local-[a-z0-9-]+-artifact:\/\/[^\s"'`\]]+/gi) || []),
    ...(value.match(/tool-result:\/\/[^\s"'`\]]+/gi) || []),
    ...(value.match(/goal-plan:\/\/[^\s"'`\]]+/gi) || []),
  ], limit);

  const pathPatterns = [
    /(?:stdoutPath|stderrPath|metadataPath|path)\s*[:=]\s*["']([^"']+)["']/g,
    /(?:^|\s)(\/(?:Users|home|tmp|var|private|Volumes)\/[^\s"'`\]]+)/g,
    /(?:^|\s)([A-Za-z]:\\[^\s"'`\]]+)/g,
  ];
  const paths: string[] = [];
  for (const pattern of pathPatterns) {
    for (const match of value.matchAll(pattern)) {
      const candidate = match[1] || match[0];
      if (candidate) paths.push(candidate.trim());
    }
  }

  const retrievalPatterns = [
    /(?:^|\n)\s*((?:rg|tail|sed|cat|head|read_file)\b[^\n]{0,240})/g,
  ];
  const suggestedRetrieval: string[] = [];
  for (const pattern of retrievalPatterns) {
    for (const match of value.matchAll(pattern)) {
      const cmd = String(match[1] || '').trim();
      if (cmd.length >= 8) suggestedRetrieval.push(cmd);
    }
  }

  // If we only have artifact paths, synthesize cheap retrieval commands.
  for (const ref of artifactRefs) {
    if (ref.startsWith('local-shell-artifact://') || ref.includes('/stdout')) {
      suggestedRetrieval.push(`tail -n 120 "${ref}"`);
    }
  }
  for (const filePath of uniqueNonEmptyStrings(paths, 6)) {
    if (filePath.includes('stdout') || filePath.endsWith('.txt') || filePath.endsWith('.log')) {
      suggestedRetrieval.push(`tail -n 120 "${filePath}"`);
    } else {
      suggestedRetrieval.push(`sed -n '1,120p' "${filePath}"`);
    }
  }

  return {
    artifactRefs: uniqueNonEmptyStrings(artifactRefs, limit),
    paths: uniqueNonEmptyStrings(paths, limit),
    suggestedRetrieval: uniqueNonEmptyStrings(suggestedRetrieval, limit),
  };
}

function compactLongHistoricalString(text: string, previewChars: number): string {
  const clues = extractRecoverableClues(text);
  const hasClues = clues.artifactRefs.length > 0
    || clues.paths.length > 0
    || clues.suggestedRetrieval.length > 0;
  const lines = [
    hasClues
      ? '[历史长文本已从活跃上下文压缩为预览；请用下方可回捞线索按需读取原文]'
      : '[历史长文本已从活跃上下文压缩为预览；原文没有可恢复的本地 artifact ref]',
    `originalChars: ${text.length}`,
  ];
  if (clues.artifactRefs.length > 0) {
    lines.push(`artifactRefs: ${JSON.stringify(clues.artifactRefs)}`);
  }
  if (clues.paths.length > 0) {
    lines.push(`paths: ${JSON.stringify(clues.paths)}`);
  }
  if (clues.suggestedRetrieval.length > 0) {
    lines.push('suggestedRetrieval:');
    for (const cmd of clues.suggestedRetrieval) {
      lines.push(`  - ${cmd}`);
    }
  }
  lines.push('', previewHistoricalText(text, previewChars));
  return lines.join('\n');
}

interface StringCompactResult {
  readonly content: string;
  readonly compacted: boolean;
  readonly beforeChars: number;
  readonly afterChars: number;
}

function microcompactStringContent(content: string, config: typeof MICROCOMPACTION_CONFIG): StringCompactResult {
  const parsed = tryParseJsonObject(content);
  if (parsed) {
    const compactedRef = compactLocalRefPayload(parsed, config.previewChars);
    if (compactedRef) {
      const nextContent = JSON.stringify(compactedRef, null, 2);
      if (nextContent.length < content.length) {
        return {
          content: nextContent,
          compacted: true,
          beforeChars: content.length,
          afterChars: nextContent.length,
        };
      }
    }
  }

  if (content.length <= config.triggerChars) {
    return { content, compacted: false, beforeChars: content.length, afterChars: content.length };
  }

  const nextContent = compactLongHistoricalString(content, config.previewChars);
  return {
    content: nextContent,
    compacted: true,
    beforeChars: content.length,
    afterChars: nextContent.length,
  };
}

function microcompactBlockContent(block: AnyRecord, config: typeof MICROCOMPACTION_CONFIG) {
  if (block?.type === 'tool_result' && typeof block.content === 'string') {
    const result = microcompactStringContent(block.content, config);
    if (result.compacted) {
      return {
        block: { ...block, content: result.content },
        compacted: true,
        beforeChars: result.beforeChars,
        afterChars: result.afterChars,
      };
    }
  }

  if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > config.triggerChars) {
    const result = microcompactStringContent(block.text, config);
    if (result.compacted) {
      return {
        block: { ...block, text: result.content },
        compacted: true,
        beforeChars: result.beforeChars,
        afterChars: result.afterChars,
      };
    }
  }

  return { block, compacted: false, beforeChars: 0, afterChars: 0 };
}

function microcompactMessageContent(content: unknown, config: typeof MICROCOMPACTION_CONFIG) {
  if (typeof content === 'string') {
    const result = microcompactStringContent(content, config);
    return { content: result.content, compacted: result.compacted, beforeChars: result.beforeChars, afterChars: result.afterChars };
  }

  if (Array.isArray(content)) {
    let compacted = false;
    let beforeChars = 0;
    let afterChars = 0;
    const blocks = content.map((block) => {
      const result = microcompactBlockContent(block as AnyRecord, config);
      if (result.compacted) {
        compacted = true;
        beforeChars += result.beforeChars;
        afterChars += result.afterChars;
      }
      return result.block;
    });
    return { content: blocks, compacted, beforeChars, afterChars };
  }

  return { content, compacted: false, beforeChars: 0, afterChars: 0 };
}

/**
 * 对「最近 keepRecentCount 条非 system 消息之外」的历史消息做证据引用化/预览化。
 * system 与 `_compaction` handoff 不参与;已是 local_*_ref 的结果保留骨架不重复截断。
 */
export function microcompactMessagesForContext<TMessage extends MicrocompactMessage>(
  messages: readonly TMessage[],
  options: Partial<typeof MICROCOMPACTION_CONFIG> = {},
): MicrocompactResult<TMessage> {
  const config = { ...MICROCOMPACTION_CONFIG, ...options };
  let recentNonSystemSeen = 0;
  const compactableIndexes = new Set<number>();

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === 'system' || message?._compaction) continue;
    recentNonSystemSeen++;
    if (recentNonSystemSeen > config.keepRecentCount) {
      compactableIndexes.add(index);
    }
  }

  let compactedCount = 0;
  let beforeChars = 0;
  let afterChars = 0;
  const nextMessages = messages.map((message, index) => {
    if (!compactableIndexes.has(index)) return message;
    const result = microcompactMessageContent(message.content, config);
    if (!result.compacted) return message;
    compactedCount++;
    beforeChars += result.beforeChars;
    afterChars += result.afterChars;
    return {
      ...message,
      content: result.content,
      _microCompaction: {
        method: 'historical_context_preview',
        beforeChars: result.beforeChars,
        afterChars: result.afterChars,
      },
    } as TMessage;
  });

  return {
    messages: compactedCount > 0 ? nextMessages : messages,
    stats: {
      compactedCount,
      beforeChars,
      afterChars,
      savedChars: Math.max(0, beforeChars - afterChars),
    },
  };
}
