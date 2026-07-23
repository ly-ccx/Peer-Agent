import type { ModelMessage } from '@peer-agent/runtime-node';

/**
 * CLI context accounting aligned with Desktop Runtime preflight:
 * - nextRequestInputTokens estimates the messages in the next final request
 * - compactionPressureTokens is the independent conservative auto-compact signal
 * - provider usage is diagnostic only and never locks either value at a historical high-water mark
 *
 * Desktop also folds tool-schema tokens into the estimate. CLI currently
 * estimates conversation messages only because tool schemas are projected later
 * by the runtime pipeline.
 */

export const TUI_COMPACTION_CONFIG = Object.freeze({
  triggerRatio: 0.8,
  charsPerToken: 4,
  cjkCharsPerToken: 1.7,
  imageTokens: 2_000,
  messageFramingTokens: 4,
  toolCallBlockOverhead: 4,
});

export interface ContextPressureUsage {
  readonly inputTokens?: number;
  readonly cacheReadTokens?: number;
}

export interface ContextPressureInfo {
  readonly estimatedTokens: number;
  readonly usageTokens: number;
  /** Estimated input for the next final provider request; used by status display. */
  readonly nextRequestInputTokens: number;
  /** Conservative pressure used only for automatic compaction decisions. */
  readonly compactionPressureTokens: number;
  readonly contextWindow: number | null;
  readonly triggerRatio: number;
  readonly shouldCompact: boolean;
  readonly percent: number | null;
}

const CJK_REGEX =
  /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]/g;

function safeTokenCount(value: number | undefined): number {
  return Number.isFinite(value) && (value as number) > 0 ? Math.floor(value as number) : 0;
}

/** CJK-aware rough token estimate (matches Desktop context-compactor). */
export function estimateTextTokens(text: string | null | undefined): number {
  if (!text) return 0;
  const str = typeof text === 'string' ? text : String(text);
  const cjkMatches = str.match(CJK_REGEX);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const otherCount = str.length - cjkCount;
  return (
    cjkCount / TUI_COMPACTION_CONFIG.cjkCharsPerToken
    + otherCount / TUI_COMPACTION_CONFIG.charsPerToken
  );
}

export function estimateTokensFromMessages(messages: readonly ModelMessage[]): number {
  let tokens = 0;
  for (const message of messages) {
    if (typeof message.content === 'string') {
      tokens += estimateTextTokens(message.content);
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part && typeof part === 'object' && 'type' in part) {
          if (part.type === 'text' && 'text' in part) {
            tokens += estimateTextTokens(String(part.text ?? ''));
          } else if (part.type === 'image_url') {
            tokens += TUI_COMPACTION_CONFIG.imageTokens;
          } else {
            tokens += estimateTextTokens(JSON.stringify(part));
          }
        } else {
          tokens += estimateTextTokens(JSON.stringify(part));
        }
      }
    }

    if (Array.isArray(message.toolCalls)) {
      for (const call of message.toolCalls) {
        tokens += estimateTextTokens(call.name ?? '');
        tokens += estimateTextTokens(call.arguments ?? '');
        tokens += TUI_COMPACTION_CONFIG.toolCallBlockOverhead;
      }
    }

    tokens += TUI_COMPACTION_CONFIG.messageFramingTokens;
  }
  return Math.ceil(tokens);
}

export function usageTokensFromSnapshot(usage: ContextPressureUsage | undefined): number {
  return safeTokenCount(usage?.inputTokens) + safeTokenCount(usage?.cacheReadTokens);
}

export function computeContextPressure(input: {
  readonly messages: readonly ModelMessage[];
  readonly contextWindow?: number | null;
  readonly usage?: ContextPressureUsage;
  /** Extra draft / upcoming user content to fold into the estimate (chars). */
  readonly draftText?: string;
}): ContextPressureInfo {
  const estimatedTokens =
    estimateTokensFromMessages(input.messages)
    + Math.ceil(estimateTextTokens(input.draftText));
  const usageTokens = usageTokensFromSnapshot(input.usage);
  // The next request is projected from the messages that will actually be sent.
  // Keep compaction pressure independent so historical provider usage cannot pin
  // either the status display or a post-compaction snapshot at an old high-water mark.
  const nextRequestInputTokens = estimatedTokens;
  const compactionPressureTokens = estimatedTokens;
  const contextWindow =
    Number.isFinite(input.contextWindow) && (input.contextWindow as number) > 0
      ? Math.floor(input.contextWindow as number)
      : null;
  const triggerRatio = TUI_COMPACTION_CONFIG.triggerRatio;
  const shouldCompact =
    contextWindow != null
    && compactionPressureTokens >= Math.floor(contextWindow * triggerRatio);
  const percent =
    contextWindow != null
      ? Math.min(100, Math.max(0, Math.round((nextRequestInputTokens / contextWindow) * 100)))
      : null;

  return {
    estimatedTokens,
    usageTokens,
    nextRequestInputTokens,
    compactionPressureTokens,
    contextWindow,
    triggerRatio,
    shouldCompact,
    percent,
  };
}
