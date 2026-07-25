export const CONTEXT_PROJECTION_CONFIG = Object.freeze({
  triggerRatio: 0.8,
  hardRatio: 0.92,
  charsPerToken: 4,
  cjkCharsPerToken: 1.7,
  imageTokens: 2_000,
  messageFramingTokens: 4,
  toolCallBlockOverhead: 8,
  toolDefinitionOverhead: 16,
});

export type ContextProjectionPhase =
  | 'request_preflight'
  | 'stream_preview'
  | 'tool_result'
  | 'post_compaction'
  | 'turn_complete'
  | 'restored';

export type ContextProjectionQuality = 'exact' | 'projected' | 'preview' | 'unknown';
export type ContextPressure = 'unknown' | 'ok' | 'soft' | 'hard' | 'overflow';
export type CompactionDecisionReason =
  | 'unknown_window'
  | 'below_threshold'
  | 'soft_limit'
  | 'hard_limit'
  | 'context_overflow'
  | 'insufficient_summary_headroom';

export interface ContextProjection {
  version: 1;
  phase: ContextProjectionPhase;
  quality: ContextProjectionQuality;
  reason: string;
  currentInputTokens: number | null;
  nextRequestInputTokens: number | null;
  previewInputTokens: number | null;
  compactionPressureTokens: number | null;
  contextWindow: number | null;
  percent: number | null;
  pressure: ContextPressure;
  updatedAt: number;
}

export interface CompactionDecision {
  shouldCompact: boolean;
  force: boolean;
  pressure: ContextPressure;
  reason: CompactionDecisionReason;
  triggerRatio: number;
  hardRatio: number;
  softLimit: number | null;
  hardLimit: number | null;
}

type MessageLike = Readonly<{
  role?: string;
  content?: unknown;
  toolCalls?: readonly unknown[];
  tool_calls?: readonly unknown[];
}>;
type ToolLike = Readonly<Record<string, unknown>>;

const CJK_REGEX =
  /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]/g;

function finitePositive(value: unknown): number | null {
  return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : null;
}

export function estimateContextTextTokens(text: unknown): number {
  if (text == null || text === '') return 0;
  const value = typeof text === 'string' ? text : String(text);
  const cjkCount = value.match(CJK_REGEX)?.length ?? 0;
  return cjkCount / CONTEXT_PROJECTION_CONFIG.cjkCharsPerToken
    + (value.length - cjkCount) / CONTEXT_PROJECTION_CONFIG.charsPerToken;
}

function estimateJson(value: unknown): number {
  try {
    return estimateContextTextTokens(typeof value === 'string' ? value : JSON.stringify(value));
  } catch {
    return 0;
  }
}

export function estimateContextMessagesTokens(messages: readonly MessageLike[] | null | undefined): number {
  let tokens = 0;
  for (const message of messages ?? []) {
    const content = message?.content;
    if (typeof content === 'string') {
      tokens += estimateContextTextTokens(content);
    } else if (Array.isArray(content)) {
      for (const rawPart of content) {
        if (!rawPart || typeof rawPart !== 'object') continue;
        const part = rawPart as Record<string, unknown>;
        const type = String(part.type ?? '');
        if (type === 'text' || type === 'input_text' || type === 'output_text') {
          tokens += estimateContextTextTokens(part.text);
        } else if (type === 'tool_use' || type === 'tool_call' || type === 'functionCall' || type === 'function_call') {
          tokens += CONTEXT_PROJECTION_CONFIG.toolCallBlockOverhead;
          tokens += estimateContextTextTokens(part.name) + estimateContextTextTokens(part.id);
          tokens += estimateJson(part.input ?? part.arguments);
        } else if (type === 'tool_result' || type === 'functionResponse' || type === 'function_response') {
          tokens += CONTEXT_PROJECTION_CONFIG.toolCallBlockOverhead;
          tokens += estimateContextTextTokens(part.tool_use_id ?? part.id ?? part.name);
          tokens += estimateJson(part.content ?? part.response);
        } else if (
          type === 'image'
          || type === 'image_url'
          || type === 'input_image'
          || type === 'document'
          || type === 'file'
          || type === 'input_file'
        ) {
          // 二进制/媒体块一律 flat 计:绝不能落到 estimateJson 把 base64 当文本展开。
          tokens += CONTEXT_PROJECTION_CONFIG.imageTokens;
        } else {
          tokens += estimateJson(part);
        }
      }
    } else if (content != null) {
      tokens += estimateJson(content);
    }
    const topLevelToolCalls = message.toolCalls ?? message.tool_calls;
    for (const rawCall of topLevelToolCalls ?? []) {
      if (!rawCall || typeof rawCall !== 'object') continue;
      const call = rawCall as Record<string, unknown>;
      const fn = call.function && typeof call.function === 'object'
        ? call.function as Record<string, unknown>
        : call;
      tokens += CONTEXT_PROJECTION_CONFIG.toolCallBlockOverhead;
      tokens += estimateContextTextTokens(call.id);
      tokens += estimateContextTextTokens(fn.name);
      tokens += estimateJson(fn.arguments ?? fn.input ?? call.arguments ?? call.input);
    }
    tokens += CONTEXT_PROJECTION_CONFIG.messageFramingTokens;
  }
  return Math.ceil(tokens);
}

export function estimateContextToolsTokens(tools: readonly ToolLike[] | ToolLike | null | undefined): number {
  if (!tools) return 0;
  const source = Array.isArray(tools)
    ? tools
    : Array.isArray((tools as ToolLike).functionDeclarations)
      ? ((tools as ToolLike).functionDeclarations as readonly ToolLike[])
      : [tools as ToolLike];
  let tokens = 0;
  for (const tool of source) {
    if (Array.isArray(tool?.functionDeclarations)) {
      tokens += estimateContextToolsTokens(tool.functionDeclarations as readonly ToolLike[]);
      continue;
    }
    const fn = tool?.function && typeof tool.function === 'object'
      ? tool.function as ToolLike
      : tool;
    tokens += estimateContextTextTokens(fn?.name ?? tool?.name);
    tokens += estimateContextTextTokens(fn?.description ?? tool?.description);
    tokens += estimateJson(fn?.parameters ?? fn?.input_schema ?? tool?.parameters ?? tool?.input_schema ?? tool?.inputSchema ?? {});
    tokens += CONTEXT_PROJECTION_CONFIG.toolDefinitionOverhead;
  }
  return Math.ceil(tokens);
}

/**
 * Host-neutral prompt-too-long classification shared by Desktop provider loops
 * and CLI/TUI emergency recovery. Providers surface this failure in many shapes;
 * classification must stay single-sourced so both hosts retry under the same policy.
 */
export function isPromptTooLongError(
  status: number | null | undefined,
  text: string | null | undefined,
): boolean {
  if (status === 413) return true;
  const value = String(text ?? '').toLowerCase();
  return (
    value.includes('prompt_too_long')
    || value.includes('context_length_exceeded')
    || value.includes('maximum context length')
    || value.includes('maximum prompt length')
    || value.includes('context window')
    || value.includes('context too long')
    || value.includes('input is too long')
    || value.includes('exceeds model context')
    || value.includes('too many tokens')
    || value.includes('token limit')
  );
}

export function decideContextCompaction(options: {
  pressureTokens: number | null | undefined;
  contextWindow: number | null | undefined;
  triggerRatio?: number;
  hardRatio?: number;
  summaryReserveTokens?: number;
}): CompactionDecision {
  const contextWindow = finitePositive(options.contextWindow);
  const pressureTokens = finitePositive(options.pressureTokens) ?? 0;
  const triggerRatio = options.triggerRatio ?? CONTEXT_PROJECTION_CONFIG.triggerRatio;
  const hardRatio = Math.max(triggerRatio, options.hardRatio ?? CONTEXT_PROJECTION_CONFIG.hardRatio);
  if (contextWindow == null) {
    return { shouldCompact: false, force: false, pressure: 'unknown', reason: 'unknown_window', triggerRatio, hardRatio, softLimit: null, hardLimit: null };
  }
  const softLimit = Math.floor(contextWindow * triggerRatio);
  const hardLimit = Math.floor(contextWindow * hardRatio);
  const reserveLimit = Math.max(1, contextWindow - Math.max(0, options.summaryReserveTokens ?? 0));
  if (pressureTokens > contextWindow) return { shouldCompact: true, force: true, pressure: 'overflow', reason: 'context_overflow', triggerRatio, hardRatio, softLimit, hardLimit };
  if (pressureTokens >= hardLimit) return { shouldCompact: true, force: true, pressure: 'hard', reason: 'hard_limit', triggerRatio, hardRatio, softLimit, hardLimit };
  if (pressureTokens >= reserveLimit) return { shouldCompact: true, force: false, pressure: 'soft', reason: 'insufficient_summary_headroom', triggerRatio, hardRatio, softLimit, hardLimit };
  if (pressureTokens >= softLimit) return { shouldCompact: true, force: false, pressure: 'soft', reason: 'soft_limit', triggerRatio, hardRatio, softLimit, hardLimit };
  return { shouldCompact: false, force: false, pressure: 'ok', reason: 'below_threshold', triggerRatio, hardRatio, softLimit, hardLimit };
}

export function projectContext(options: {
  messages?: readonly MessageLike[] | null;
  tools?: readonly ToolLike[] | ToolLike | null;
  draftTokens?: number | null;
  currentInputTokens?: number | null;
  previewInputTokens?: number | null;
  contextWindow?: number | null;
  phase: ContextProjectionPhase;
  quality?: ContextProjectionQuality;
  reason?: string;
  now?: number;
}): ContextProjection {
  const contextWindow = finitePositive(options.contextWindow);
  const projectedInputTokens = estimateContextMessagesTokens(options.messages)
    + estimateContextToolsTokens(options.tools)
    + (finitePositive(options.draftTokens) ?? 0);
  const currentInputTokens = finitePositive(options.currentInputTokens);
  // Provider-observed usage is authoritative. The local projection remains a
  // diagnostic fallback only until an observation exists.
  const nextRequestInputTokens = currentInputTokens ?? projectedInputTokens;
  const previewInputTokens = finitePositive(options.previewInputTokens);
  const compactionPressureTokens = previewInputTokens ?? nextRequestInputTokens;
  const decision = decideContextCompaction({ pressureTokens: compactionPressureTokens, contextWindow });
  return {
    version: 1,
    phase: options.phase,
    quality:
      options.quality
      ?? (options.phase === 'stream_preview' ? 'preview' : currentInputTokens ? 'exact' : 'projected'),
    reason: options.reason ?? decision.reason,
    currentInputTokens,
    nextRequestInputTokens,
    previewInputTokens,
    compactionPressureTokens,
    contextWindow,
    percent: contextWindow == null ? null : Math.min(100, Math.round((compactionPressureTokens / contextWindow) * 100)),
    pressure: decision.pressure,
    updatedAt: options.now ?? Date.now(),
  };
}
