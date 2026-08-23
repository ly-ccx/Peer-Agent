import {
  CONTEXT_USAGE_CATEGORY_IDS,
  normalizeContextUsageBreakdown,
  type ContextUsageBreakdown,
  type ContextUsageCategoryId,
} from '@peer-agent/protocol';
import {
  estimateContextMessagesTokens,
  estimateContextTextTokens,
  estimateContextToolsTokens,
} from './context-projection.ts';

export type ContextUsageSectionLike = Readonly<{
  readonly id?: unknown;
  readonly layer?: unknown;
  readonly content?: unknown;
  readonly source?: unknown;
  readonly sourceKind?: unknown;
}>;

export type ContextUsageMessageLike = Readonly<{
  readonly role?: unknown;
  readonly content?: unknown;
  readonly _compaction?: unknown;
  readonly toolCalls?: unknown;
  readonly tool_calls?: unknown;
}>;

export type ComposeContextUsageBreakdownInput = Readonly<{
  readonly systemPrompt?: string | null;
  readonly systemSections?: readonly ContextUsageSectionLike[] | null;
  readonly tools?: unknown;
  readonly messages?: unknown;
  readonly authoritativeTokens?: number | null;
}>;

const CATEGORY_ORDER = new Map<ContextUsageCategoryId, number>(
  CONTEXT_USAGE_CATEGORY_IDS.map((id, index) => [id, index]),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function haystackOf(...parts: readonly unknown[]): string {
  return parts
    .map((part) => (typeof part === 'string' ? part : ''))
    .join(' ')
    .toLowerCase();
}

function classifySection(section: ContextUsageSectionLike): ContextUsageCategoryId {
  const source = isRecord(section.source) ? section.source : {};
  const haystack = haystackOf(
    section.id,
    section.layer,
    section.sourceKind,
    source.id,
    source.kind,
  );
  const layer = String(section.layer ?? '');
  if (haystack.includes('mcp')) return 'mcp_tools';
  if (haystack.includes('skill')) return 'skills';
  if (
    haystack.includes('subagent')
    || haystack.includes('explorer')
    || haystack.includes('verifier')
  ) {
    return 'subagents';
  }
  if (
    layer === 'L3_INSTRUCTIONS'
    || haystack.includes('instruction')
    || haystack.includes('rule')
  ) {
    return 'rules';
  }
  if (layer === 'L7_CONTINUITY' || haystack.includes('continuity') || haystack.includes('compaction')) {
    return 'summarized_conversation';
  }
  if (layer === 'L4_CAPABILITIES') return 'skills';
  return 'system_prompt';
}

function classifyTool(tool: unknown): ContextUsageCategoryId {
  const record = isRecord(tool) ? tool : {};
  const fn = isRecord(record.function) ? record.function : {};
  const runtime = isRecord(record.runtime) ? record.runtime : {};
  const haystack = haystackOf(
    record.capabilityId,
    runtime.executorCapabilityId,
    record.name,
    fn.name,
  );
  if (haystack.includes('mcp')) return 'mcp_tools';
  if (haystack.includes('skill')) return 'skills';
  if (
    haystack.includes('subagent')
    || haystack.includes('explorer')
    || haystack.includes('verifier')
  ) {
    return 'subagents';
  }
  return 'tool_definitions';
}

function classifyMessage(message: ContextUsageMessageLike): ContextUsageCategoryId {
  if (message._compaction) return 'summarized_conversation';
  if (message.role === 'system') return 'system_prompt';
  return 'conversation';
}

function addTokens(
  buckets: Map<ContextUsageCategoryId, number>,
  id: ContextUsageCategoryId,
  tokens: number,
): void {
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  buckets.set(id, (buckets.get(id) ?? 0) + tokens);
}

function listTools(tools: unknown): readonly unknown[] {
  if (!tools) return [];
  if (Array.isArray(tools)) return tools;
  if (isRecord(tools) && Array.isArray(tools.functionDeclarations)) {
    return tools.functionDeclarations;
  }
  return [tools];
}

function listMessages(messages: unknown): readonly ContextUsageMessageLike[] {
  if (!Array.isArray(messages)) return [];
  return messages.filter((message): message is ContextUsageMessageLike => isRecord(message));
}

function scaleBreakdown(
  buckets: Map<ContextUsageCategoryId, number>,
  authoritativeTokens: number | null | undefined,
): ContextUsageBreakdown | null {
  const raw = [...buckets.entries()]
    .filter(([, tokens]) => tokens > 0)
    .map(([id, tokens]) => [id, Math.max(1, Math.round(tokens))] as const);
  const estimatedTokens = raw.reduce((sum, [, tokens]) => sum + tokens, 0);
  if (raw.length === 0 || estimatedTokens <= 0) return null;

  const authoritative = typeof authoritativeTokens === 'number'
    && Number.isFinite(authoritativeTokens)
    && authoritativeTokens > 0
    ? Math.floor(authoritativeTokens)
    : null;

  if (authoritative == null) {
    return {
      version: 1,
      quality: 'projected',
      estimatedTokens,
      categories: raw
        .sort((a, b) => (CATEGORY_ORDER.get(a[0]) ?? 99) - (CATEGORY_ORDER.get(b[0]) ?? 99))
        .map(([id, tokens]) => ({ id, tokens })),
    };
  }

  const scale = authoritative / estimatedTokens;
  const scaled: Array<[ContextUsageCategoryId, number]> = raw.map(([id, tokens]) => [
    id,
    Math.max(0, Math.round(tokens * scale)),
  ]);
  let sum = scaled.reduce((total, [, tokens]) => total + tokens, 0);
  if (sum !== authoritative && scaled.length > 0) {
    let largestIndex = 0;
    for (let index = 1; index < scaled.length; index += 1) {
      if (scaled[index][1] > scaled[largestIndex][1]) largestIndex = index;
    }
    scaled[largestIndex][1] = Math.max(0, scaled[largestIndex][1] + (authoritative - sum));
    sum = scaled.reduce((total, [, tokens]) => total + tokens, 0);
  }

  const categories = scaled
    .filter(([, tokens]) => tokens > 0)
    .sort((a, b) => (CATEGORY_ORDER.get(a[0]) ?? 99) - (CATEGORY_ORDER.get(b[0]) ?? 99))
    .map(([id, tokens]) => ({ id, tokens }));
  if (categories.length === 0) return null;
  return {
    version: 1,
    quality: 'scaled',
    estimatedTokens: sum,
    categories,
  };
}

/**
 * Host-neutral presentation composition for the last built request.
 * Renderer must display the result; it must not re-estimate occupancy.
 */
export function composeContextUsageBreakdown(
  input: ComposeContextUsageBreakdownInput,
): ContextUsageBreakdown | null {
  const buckets = new Map<ContextUsageCategoryId, number>();
  const sections = Array.isArray(input.systemSections) ? input.systemSections : [];
  if (sections.length > 0) {
    for (const section of sections) {
      addTokens(buckets, classifySection(section), estimateContextTextTokens(section.content));
    }
  } else if (typeof input.systemPrompt === 'string' && input.systemPrompt) {
    addTokens(buckets, 'system_prompt', estimateContextTextTokens(input.systemPrompt));
  }

  for (const tool of listTools(input.tools)) {
    addTokens(buckets, classifyTool(tool), estimateContextToolsTokens([tool as never]));
  }

  for (const message of listMessages(input.messages)) {
    addTokens(
      buckets,
      classifyMessage(message),
      estimateContextMessagesTokens([{
        role: typeof message.role === 'string' ? message.role : undefined,
        content: message.content,
        toolCalls: Array.isArray(message.toolCalls) ? message.toolCalls : undefined,
        tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls : undefined,
      }]),
    );
  }

  return scaleBreakdown(buckets, input.authoritativeTokens);
}

export function composeContextUsageBreakdownFromRequest(
  request: unknown,
  authoritativeTokens?: number | null,
): ContextUsageBreakdown | null {
  if (!isRecord(request)) return null;
  const systemSections = Array.isArray(request.systemSections)
    ? request.systemSections
    : Array.isArray(request.systemContextSections)
      ? request.systemContextSections
      : null;
  const systemPrompt = typeof request.systemPrompt === 'string'
    ? request.systemPrompt
    : typeof request.system === 'string'
      ? request.system
      : null;
  return composeContextUsageBreakdown({
    systemPrompt,
    systemSections,
    tools: request.tools,
    messages: request.messages,
    authoritativeTokens,
  });
}

export function retainContextUsageBreakdown(
  value: unknown,
): ContextUsageBreakdown | undefined {
  return normalizeContextUsageBreakdown(value) ?? undefined;
}
