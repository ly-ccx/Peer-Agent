import type { ModelMessage } from '@peer-agent/runtime-node';

/**
 * nextRequest context accounting shared with Desktop Runtime preflight:
 * - nextRequestInputTokens = messages (+ draft) + tools schema for the next final request
 * - compactionPressureTokens is the independent conservative auto-compact signal
 * - provider usage is diagnostic only and never locks either value at a historical high-water mark
 *
 * Token constants and estimators are kept in lockstep with Desktop
 * `apps/desktop/electron/main/context-compactor.mjs` + `computeContextBudget`.
 */

export const TUI_COMPACTION_CONFIG = Object.freeze({
  triggerRatio: 0.8,
  charsPerToken: 4,
  cjkCharsPerToken: 1.7,
  imageTokens: 2_000,
  messageFramingTokens: 4,
  /** Desktop-aligned tool_use / tool_result / functionCall block overhead. */
  toolCallBlockOverhead: 8,
  /** Desktop-aligned per-tool-definition overhead. */
  toolDefinitionOverhead: 16,
});

export interface ContextPressureUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
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

/** Loose tool-definition shape accepted by Desktop-aligned schema estimation. */
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
  readonly [key: string]: unknown;
};

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

/**
 * Estimate tool-schema tokens for the next provider request.
 * Mirrors Desktop `estimateToolsTokens` (OpenAI / Anthropic / Gemini shapes).
 */
export function estimateToolsTokens(
  tools: readonly ContextToolDefinitionLike[] | ContextToolDefinitionLike | null | undefined,
): number {
  if (!tools) return 0;

  let list: readonly ContextToolDefinitionLike[];
  if (!Array.isArray(tools)) {
    if (Array.isArray(tools.functionDeclarations)) {
      list = tools.functionDeclarations;
    } else {
      list = [tools];
    }
  } else {
    list = tools;
  }

  let tokens = 0;
  for (const tool of list) {
    if (!tool || typeof tool !== 'object') continue;
    if (Array.isArray(tool.functionDeclarations)) {
      tokens += estimateToolsTokens(tool.functionDeclarations);
      continue;
    }
    const fn = tool.function && typeof tool.function === 'object' ? tool.function : tool;
    const name = fn.name || tool.name || '';
    const description = fn.description || tool.description || '';
    const schema =
      fn.parameters ?? fn.input_schema ?? tool.parameters ?? tool.input_schema ?? {};
    tokens += estimateTextTokens(name);
    tokens += estimateTextTokens(description);
    try {
      tokens += estimateTextTokens(JSON.stringify(schema));
    } catch {
      // ignore non-serializable schema
    }
    tokens += TUI_COMPACTION_CONFIG.toolDefinitionOverhead;
  }
  return Math.ceil(tokens);
}

/**
 * Desktop-aligned message token estimate for the next final request body.
 * Supports text, tool_use / tool_call / functionCall, tool_result / functionResponse, image-like parts.
 */
export function estimateTokensFromMessages(messages: readonly ModelMessage[]): number {
  let tokens = 0;
  for (const message of messages) {
    if (typeof message.content === 'string') {
      tokens += estimateTextTokens(message.content);
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!part || typeof part !== 'object') continue;
        const typed = part as {
          type?: string;
          text?: string;
          content?: unknown;
          input?: unknown;
          arguments?: unknown;
          name?: string;
          id?: string;
        };
        const type = typed.type;
        if (type === 'text' || type === 'input_text' || type === 'output_text') {
          tokens += estimateTextTokens(typed.text ?? '');
          continue;
        }
        if (
          type === 'tool_use'
          || type === 'tool_call'
          || type === 'functionCall'
          || type === 'function_call'
        ) {
          tokens += TUI_COMPACTION_CONFIG.toolCallBlockOverhead;
          tokens += estimateTextTokens(typed.name ?? '');
          tokens += estimateTextTokens(typed.id ?? '');
          const args = typed.input ?? typed.arguments;
          if (args != null) {
            try {
              tokens += estimateTextTokens(
                typeof args === 'string' ? args : JSON.stringify(args),
              );
            } catch {
              // ignore
            }
          }
          continue;
        }
        if (
          type === 'tool_result'
          || type === 'functionResponse'
          || type === 'function_response'
        ) {
          tokens += TUI_COMPACTION_CONFIG.toolCallBlockOverhead;
          tokens += estimateTextTokens(typed.id ?? '');
          const content = typed.content;
          if (typeof content === 'string') {
            tokens += estimateTextTokens(content);
          } else if (content != null) {
            try {
              tokens += estimateTextTokens(JSON.stringify(content));
            } catch {
              // ignore
            }
          }
          continue;
        }
        if (
          type === 'image'
          || type === 'image_url'
          || type === 'input_image'
          || type === 'document'
          || type === 'file'
          || type === 'input_file'
        ) {
          tokens += TUI_COMPACTION_CONFIG.imageTokens;
          continue;
        }
        if (typeof typed.text === 'string') {
          tokens += estimateTextTokens(typed.text);
        }
      }
    }

    const toolCalls = (message as { tool_calls?: readonly unknown[] }).tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const call of toolCalls) {
        if (!call || typeof call !== 'object') continue;
        tokens += TUI_COMPACTION_CONFIG.toolCallBlockOverhead;
        const typed = call as {
          function?: { name?: string; arguments?: unknown };
          name?: string;
          arguments?: unknown;
          id?: string;
        };
        const fn = typed.function && typeof typed.function === 'object' ? typed.function : typed;
        tokens += estimateTextTokens(fn.name ?? typed.name ?? '');
        tokens += estimateTextTokens(typed.id ?? '');
        const args = fn.arguments ?? typed.arguments;
        if (args != null) {
          try {
            tokens += estimateTextTokens(typeof args === 'string' ? args : JSON.stringify(args));
          } catch {
            // ignore
          }
        }
      }
    }

    tokens += TUI_COMPACTION_CONFIG.messageFramingTokens;
  }
  return Math.ceil(tokens);
}

/**
 * Shared next-request budget: messages (+ optional draft) + tools schema.
 * Matches Desktop `computeContextBudget` numerator (without Desktop-only microcompact side effects).
 */
export function computeNextRequestInputTokens(input: {
  readonly messages: readonly ModelMessage[];
  readonly tools?: readonly ContextToolDefinitionLike[] | ContextToolDefinitionLike | null;
  readonly draftText?: string;
}): number {
  return (
    estimateTokensFromMessages(input.messages)
    + Math.ceil(estimateTextTokens(input.draftText))
    + estimateToolsTokens(input.tools)
  );
}

/**
 * Compose status / auto-compact pressure from the shared next-request budget.
 */
export function computeContextPressure(input: {
  readonly messages: readonly ModelMessage[];
  readonly contextWindow?: number | null;
  readonly usage?: ContextPressureUsage;
  /** Extra draft / upcoming user content to fold into the estimate (chars). */
  readonly draftText?: string;
  /**
   * Tool schemas included in the next final provider request.
   * Desktop folds these into nextRequestInputTokens; TUI must too.
   */
  readonly tools?: readonly ContextToolDefinitionLike[] | ContextToolDefinitionLike | null;
}): ContextPressureInfo {
  const estimatedTokens = computeNextRequestInputTokens({
    messages: input.messages,
    tools: input.tools,
    draftText: input.draftText,
  });
  const usageTokens =
    safeTokenCount(input.usage?.inputTokens) + safeTokenCount(input.usage?.cacheReadTokens);
  // Keep the two axes independent:
  // - nextRequestInputTokens drives the visible occupancy meter
  // - compactionPressureTokens is a conservative auto-compact signal
  // Provider usage remains diagnostic and must not raise either axis after a shrink.
  const nextRequestInputTokens = estimatedTokens;
  const compactionPressureTokens = estimatedTokens;
  const contextWindow = safeTokenCount(input.contextWindow ?? undefined) || null;
  const triggerRatio = TUI_COMPACTION_CONFIG.triggerRatio;
  const shouldCompact = contextWindow != null
    ? compactionPressureTokens >= Math.floor(contextWindow * triggerRatio)
    : false;
  const percent = contextWindow != null
    ? Math.min(100, Math.round((nextRequestInputTokens / contextWindow) * 100))
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
