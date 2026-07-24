import type { ModelMessage } from '@peer-agent/runtime-node';
import {
  CONTEXT_PROJECTION_CONFIG,
  decideContextCompaction,
  estimateContextMessagesTokens,
  estimateContextTextTokens,
  estimateContextToolsTokens,
} from '@peer-agent/runtime-core';

/**
 * TUI compatibility facade over the host-independent Runtime context policy.
 * Keep these names for callers, but do not define token constants or threshold logic here.
 */
export const TUI_COMPACTION_CONFIG = CONTEXT_PROJECTION_CONFIG;

export interface ContextPressureUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
}

export interface ContextPressureInfo {
  readonly estimatedTokens: number;
  readonly usageTokens: number;
  readonly nextRequestInputTokens: number;
  readonly compactionPressureTokens: number;
  readonly contextWindow: number | null;
  readonly triggerRatio: number;
  readonly shouldCompact: boolean;
  readonly percent: number | null;
}

export type ContextToolDefinitionLike = {
  readonly name?: string;
  readonly description?: string;
  readonly parameters?: unknown;
  readonly input_schema?: unknown;
  readonly function?: {
    readonly name?: string;
    readonly description?: string;
    readonly parameters?: unknown;
    readonly input_schema?: unknown;
  };
  readonly functionDeclarations?: readonly ContextToolDefinitionLike[];
  readonly inputSchema?: unknown;
};

function safeTokenCount(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

export function estimateTextTokens(text: string | null | undefined): number {
  return estimateContextTextTokens(text);
}

export function estimateToolsTokens(
  tools: readonly ContextToolDefinitionLike[] | ContextToolDefinitionLike | null | undefined,
): number {
  return estimateContextToolsTokens(tools);
}

export function estimateTokensFromMessages(messages: readonly ModelMessage[]): number {
  return estimateContextMessagesTokens(messages);
}

export function computeNextRequestInputTokens(input: {
  readonly messages: readonly ModelMessage[];
  readonly tools?: readonly ContextToolDefinitionLike[] | ContextToolDefinitionLike | null;
  readonly draftText?: string;
}): number {
  return (
    estimateContextMessagesTokens(input.messages)
    + Math.ceil(estimateContextTextTokens(input.draftText))
    + estimateContextToolsTokens(input.tools)
  );
}

export function computeContextPressure(input: {
  readonly messages: readonly ModelMessage[];
  readonly contextWindow?: number | null;
  readonly usage?: ContextPressureUsage;
  readonly draftText?: string;
  readonly tools?: readonly ContextToolDefinitionLike[] | ContextToolDefinitionLike | null;
}): ContextPressureInfo {
  const estimatedTokens = computeNextRequestInputTokens({
    messages: input.messages,
    tools: input.tools,
    draftText: input.draftText,
  });
  const usageTokens =
    safeTokenCount(input.usage?.inputTokens) + safeTokenCount(input.usage?.cacheReadTokens);
  const contextWindow = safeTokenCount(input.contextWindow) || null;
  const decision = decideContextCompaction({
    pressureTokens: estimatedTokens,
    contextWindow,
  });

  return {
    estimatedTokens,
    usageTokens,
    nextRequestInputTokens: estimatedTokens,
    compactionPressureTokens: estimatedTokens,
    contextWindow,
    triggerRatio: decision.triggerRatio,
    shouldCompact: decision.shouldCompact,
    percent: contextWindow == null
      ? null
      : Math.min(100, Math.round((estimatedTokens / contextWindow) * 100)),
  };
}
