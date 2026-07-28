/**
 * Goal-mode bounded keep policy.
 *
 * Goal compaction must preserve a *bounded* executable scene, not the entire
 * current-turn tool tail. Plan/checkpoint own long-term progress; keep only
 * owns protocol locality for the next recovery turn.
 *
 * See peer-knowledge/knowledge/architecture/24-goal-runner-context-checkpoint-and-seamless-resume.md
 */
import {
  type CompactionMessage,
  splitMessagesForCompaction,
} from './context-compaction.ts';
import {
  estimateContextMessagesTokens,
  estimateContextTextTokens,
} from './context-projection.ts';
import { microcompactMessagesForContext } from './microcompact.ts';

export interface GoalKeepPolicyConfig {
  readonly maxRecentUserTurns: number;
  readonly maxRecentMessages: number;
  readonly maxCompletedToolResults: number;
  readonly minKeepTokens: number;
  readonly maxKeepTokens: number;
  readonly keepContextRatio: number;
  readonly checkpointMaxTokens: number;
  readonly continuityMaxTokens: number;
  readonly targetRequestRatio: number;
  readonly softTriggerRatio: number;
  readonly hardTriggerRatio: number;
  readonly largeToolPreviewChars: number;
  readonly largeToolTailChars: number;
  readonly largeToolTriggerChars: number;
}

export const GOAL_KEEP_POLICY: GoalKeepPolicyConfig = Object.freeze({
  maxRecentUserTurns: 2,
  maxRecentMessages: 20,
  maxCompletedToolResults: 4,
  minKeepTokens: 4_096,
  maxKeepTokens: 16_384,
  keepContextRatio: 0.10,
  checkpointMaxTokens: 4_096,
  continuityMaxTokens: 12_000,
  targetRequestRatio: 0.55,
  softTriggerRatio: 0.72,
  hardTriggerRatio: 0.88,
  largeToolPreviewChars: 800,
  largeToolTailChars: 400,
  largeToolTriggerChars: 1_500,
});

export type GoalKeepRecoveryLevel =
  | 0
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8;

export interface GoalKeepBudget {
  readonly contextWindow: number | null;
  readonly keepBudgetTokens: number;
  readonly targetRequestTokens: number | null;
  readonly softTriggerTokens: number | null;
  readonly hardTriggerTokens: number | null;
  readonly maxRecentUserTurns: number;
  readonly maxRecentMessages: number;
  readonly maxCompletedToolResults: number;
}

export interface GoalKeepSelectionResult<TMessage extends CompactionMessage = CompactionMessage> {
  readonly systemMessages: TMessage[];
  readonly oldMessages: TMessage[];
  readonly keepMessages: TMessage[];
  readonly keepBudgetTokens: number;
  readonly keepTokens: number;
  readonly recoveryLevel: GoalKeepRecoveryLevel;
  readonly degraded: boolean;
  readonly reason: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function contentBlocks(message: CompactionMessage): readonly Record<string, unknown>[] {
  return Array.isArray(message.content)
    ? message.content.filter((block): block is Record<string, unknown> => Boolean(block && typeof block === 'object'))
    : [];
}

function toolUseIds(message: CompactionMessage): string[] {
  const openAiCalls = [...(message.toolCalls ?? []), ...(message.tool_calls ?? [])]
    .map((call) => call?.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  const anthropicCalls = contentBlocks(message)
    .filter((block) => block.type === 'tool_use')
    .map((block) => block.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  return [...openAiCalls, ...anthropicCalls];
}

function toolResultIds(message: CompactionMessage): string[] {
  const direct = message.toolCallId ?? message.tool_call_id;
  const blockIds = contentBlocks(message)
    .filter((block) => block.type === 'tool_result')
    .map((block) => block.tool_use_id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  return typeof direct === 'string' && direct.length > 0 ? [direct, ...blockIds] : blockIds;
}

function hasToolResult(message: CompactionMessage): boolean {
  return message.role === 'tool' || toolResultIds(message).length > 0;
}

function isHumanUserMessage(message: CompactionMessage): boolean {
  if (message.role !== 'user' || message._compaction) return false;
  const blocks = contentBlocks(message);
  return blocks.length === 0 || blocks.some((block) => block.type !== 'tool_result');
}

function truncateText(text: string, headChars: number, tailChars: number): string {
  if (text.length <= headChars + tailChars + 32) return text;
  const omitted = text.length - headChars - tailChars;
  return `${text.slice(0, headChars)}\n…[goal-keep truncated ${omitted} chars]…\n${text.slice(-tailChars)}`;
}

function skeletonizeValue(
  value: unknown,
  headChars: number,
  tailChars: number,
): unknown {
  if (typeof value === 'string') {
    return truncateText(value, headChars, tailChars);
  }
  if (Array.isArray(value)) {
    return value.map((item) => skeletonizeValue(item, headChars, tailChars));
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    // local_*_ref already carries retrieval route; do not re-expand.
    if (typeof record.kind === 'string' && record.kind.startsWith('local_') && record.kind.endsWith('_ref')) {
      return value;
    }
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      if (key === 'content' || key === 'text' || key === 'output' || key === 'stdout' || key === 'stderr') {
        next[key] = skeletonizeValue(item, headChars, tailChars);
      } else if (typeof item === 'string' && item.length > headChars + tailChars) {
        next[key] = truncateText(item, headChars, Math.min(tailChars, 200));
      } else {
        next[key] = item;
      }
    }
    return next;
  }
  return value;
}

function skeletonizeMessageContent(
  message: CompactionMessage,
  headChars: number,
  tailChars: number,
): CompactionMessage {
  if (typeof message.content === 'string') {
    return {
      ...message,
      content: truncateText(message.content, headChars, tailChars),
    };
  }
  if (Array.isArray(message.content)) {
    return {
      ...message,
      content: message.content.map((block) => {
        if (!block || typeof block !== 'object') return block;
        const record = block as Record<string, unknown>;
        if (typeof record.text === 'string') {
          return { ...record, text: truncateText(record.text, headChars, tailChars) };
        }
        if (record.content !== undefined) {
          return { ...record, content: skeletonizeValue(record.content, headChars, tailChars) };
        }
        return record;
      }),
    };
  }
  if (message.content && typeof message.content === 'object') {
    return {
      ...message,
      content: skeletonizeValue(message.content, headChars, tailChars) as CompactionMessage['content'],
    };
  }
  return message;
}

/**
 * Convert oversized tool-result payloads in keep to short previews / refs.
 * Structure (role, tool_call_id, call/result pairing) is preserved.
 */
export function skeletonizeKeepToolResults<TMessage extends CompactionMessage>(
  keepMessages: readonly TMessage[],
  options: {
    readonly headChars?: number;
    readonly tailChars?: number;
    readonly triggerChars?: number;
  } = {},
): { messages: TMessage[]; changed: boolean } {
  const headChars = options.headChars ?? GOAL_KEEP_POLICY.largeToolPreviewChars;
  const tailChars = options.tailChars ?? GOAL_KEEP_POLICY.largeToolTailChars;
  const triggerChars = options.triggerChars ?? GOAL_KEEP_POLICY.largeToolTriggerChars;
  let changed = false;

  const messages = keepMessages.map((message) => {
    if (!hasToolResult(message) && message.role !== 'user') {
      return message;
    }

    // First pass: aggressive microcompact even for latest turn.
    // MICROCOMPACTION_CONFIG is a frozen literal object, so Partial<> rejects
    // keepRecentCount=0 / custom thresholds. Cast through unknown intentionally.
    const micro = microcompactMessagesForContext(
      [message],
      {
        keepRecentCount: 0,
        triggerChars,
        previewChars: headChars,
      } as unknown as Partial<typeof import('./microcompact.ts').MICROCOMPACTION_CONFIG>,
    );
    let next = (micro.messages[0] ?? message) as TMessage;
    if ((micro.stats?.compactedCount ?? 0) > 0) {
      changed = true;
    }

    // Second pass: hard truncate residual large payloads.
    const before = JSON.stringify(next.content ?? null);
    const skeletonized = skeletonizeMessageContent(next, headChars, tailChars) as TMessage;
    const after = JSON.stringify(skeletonized.content ?? null);
    if (before !== after) {
      changed = true;
      next = skeletonized;
    }
    return next;
  });

  return { messages, changed };
}

export function resolveGoalKeepBudget(
  contextWindow: number | null | undefined,
  config: Partial<GoalKeepPolicyConfig> = {},
): GoalKeepBudget {
  const policy = { ...GOAL_KEEP_POLICY, ...config };
  const window = typeof contextWindow === 'number' && contextWindow > 0
    ? Math.floor(contextWindow)
    : null;

  let keepBudgetTokens = policy.maxKeepTokens;
  if (window !== null) {
    keepBudgetTokens = clamp(
      Math.floor(window * policy.keepContextRatio),
      policy.minKeepTokens,
      policy.maxKeepTokens,
    );
    // Tiny windows: never force minKeepTokens above half the window.
    keepBudgetTokens = Math.min(keepBudgetTokens, Math.max(1_024, Math.floor(window * 0.5)));
  }

  return {
    contextWindow: window,
    keepBudgetTokens,
    targetRequestTokens: window === null ? null : Math.floor(window * policy.targetRequestRatio),
    softTriggerTokens: window === null ? null : Math.floor(window * policy.softTriggerRatio),
    hardTriggerTokens: window === null ? null : Math.floor(window * policy.hardTriggerRatio),
    maxRecentUserTurns: policy.maxRecentUserTurns,
    maxRecentMessages: policy.maxRecentMessages,
    maxCompletedToolResults: policy.maxCompletedToolResults,
  };
}

function countHumanUserTurns(messages: readonly CompactionMessage[]): number {
  return messages.reduce((count, message) => count + (isHumanUserMessage(message) ? 1 : 0), 0);
}

function findLatestHumanAnchorIndex(messages: readonly CompactionMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isHumanUserMessage(messages[index]!)) return index;
  }
  return -1;
}

function dropLeadingOrphanToolResults<TMessage extends CompactionMessage>(
  keep: TMessage[],
): TMessage[] {
  let next = keep;
  while (next.length > 0 && hasToolResult(next[0]!) && toolUseIds(next[0]!).length === 0) {
    const firstIds = new Set(toolResultIds(next[0]!));
    const owned = next.some((message) => toolUseIds(message).some((id) => firstIds.has(id)));
    if (owned) break;
    next = next.slice(1);
  }
  return next;
}

function trimKeepToLimits<TMessage extends CompactionMessage>(
  keepMessages: readonly TMessage[],
  budget: GoalKeepBudget,
): TMessage[] {
  let keep = [...keepMessages];

  // Message-count ceiling.
  if (keep.length > budget.maxRecentMessages) {
    keep = keep.slice(-budget.maxRecentMessages);
  }

  // User-turn ceiling (from the end).
  while (countHumanUserTurns(keep) > budget.maxRecentUserTurns && keep.length > 1) {
    // Drop from front, but never leave orphan tool results at the new head.
    keep = keep.slice(1);
    keep = dropLeadingOrphanToolResults(keep);
  }

  // Completed tool-result ceiling (keep newest N tool results).
  const toolResultIndexes: number[] = [];
  keep.forEach((message, index) => {
    if (hasToolResult(message)) toolResultIndexes.push(index);
  });
  if (toolResultIndexes.length > budget.maxCompletedToolResults) {
    const drop = new Set(toolResultIndexes.slice(0, toolResultIndexes.length - budget.maxCompletedToolResults));
    keep = keep.filter((_, index) => !drop.has(index));
  }

  // If still over token budget, skeletonize tool payloads first so we do not
  // erase the whole keep window just because one tool_result is huge.
  if (estimateContextMessagesTokens(keep) > budget.keepBudgetTokens) {
    const skeletonized = skeletonizeKeepToolResults(keep, {
      headChars: GOAL_KEEP_POLICY.largeToolPreviewChars,
      tailChars: GOAL_KEEP_POLICY.largeToolTailChars,
      triggerChars: GOAL_KEEP_POLICY.largeToolTriggerChars,
    });
    keep = skeletonized.messages;
  }

  // Token ceiling: drop oldest keep messages until under budget, but never drop
  // the latest human anchor + its trailing protocol skeleton entirely.
  while (keep.length > 1 && estimateContextMessagesTokens(keep) > budget.keepBudgetTokens) {
    const anchorIndex = findLatestHumanAnchorIndex(keep);
    // If the first message is at/after the anchor, further drops would remove
    // the recovery scene; stop and leave residual (already skeletonized).
    if (anchorIndex <= 0) break;
    keep = keep.slice(1);
    keep = dropLeadingOrphanToolResults(keep);
  }

  // Final protocol hygiene: if we still start with orphan tool results, drop them.
  keep = dropLeadingOrphanToolResults(keep);

  // Absolute fallback: never return an empty keep when input was non-empty.
  if (keep.length === 0 && keepMessages.length > 0) {
    const anchorIndex = findLatestHumanAnchorIndex(keepMessages);
    if (anchorIndex >= 0) {
      keep = keepMessages.slice(anchorIndex);
    } else {
      keep = keepMessages.slice(-1);
    }
    const skeletonized = skeletonizeKeepToolResults(keep, {
      headChars: 300,
      tailChars: 120,
      triggerChars: 400,
    });
    keep = skeletonized.messages;
  }

  return keep;
}

/**
 * Select a Goal-mode keep window with hard bounds.
 *
 * recoveryLevel:
 * - 0/1/2: normal bounded keep (turn/message/token limits)
 * - 3: aggressive tool microcompact/skeletonize inside keep
 * - 4: closed tool results → skeleton only (same pass, more aggressive)
 * - 5: shrink to latest human anchor + open tool skeleton
 * - 6+: same as 5 (further levels belong to tools/system projection outside keep)
 */
export function selectGoalKeepMessages<TMessage extends CompactionMessage>(
  messages: readonly TMessage[],
  options: {
    readonly contextWindow?: number | null;
    readonly recoveryLevel?: GoalKeepRecoveryLevel;
    readonly config?: Partial<GoalKeepPolicyConfig>;
  } = {},
): GoalKeepSelectionResult<TMessage> {
  const recoveryLevel = (options.recoveryLevel ?? 0) as GoalKeepRecoveryLevel;
  const budget = resolveGoalKeepBudget(options.contextWindow, options.config);
  const policy = { ...GOAL_KEEP_POLICY, ...(options.config ?? {}) };

  const baseSplit = splitMessagesForCompaction(messages, {
    preserveLatestUserTurn: true,
    // Goal mode preserves a short recent window, not only 1 turn.
    preserveRecentTurns: Math.max(1, budget.maxRecentUserTurns),
  });

  let keepMessages = [...baseSplit.keepMessages];
  let oldMessages = [...baseSplit.oldMessages];
  let degraded = false;
  let reason = 'bounded_recent_window';

  // Always apply hard ceilings.
  const beforeTrimTokens = estimateContextMessagesTokens(keepMessages);
  keepMessages = trimKeepToLimits(keepMessages, budget);
  if (estimateContextMessagesTokens(keepMessages) < beforeTrimTokens) {
    degraded = true;
    reason = 'trimmed_to_keep_budget';
  }

  // Recompute old as "everything conversational not in keep" while preserving order.
  if (keepMessages.length > 0) {
    const keepSet = new Set(keepMessages);
    const systemMessages = baseSplit.systemMessages;
    const conversation = messages.filter((message) => message.role !== 'system');
    oldMessages = conversation.filter((message) => !keepSet.has(message));
    // system messages remain separate
    void systemMessages;
  }

  if (recoveryLevel >= 3) {
    const skeleton = skeletonizeKeepToolResults(keepMessages, {
      headChars: recoveryLevel >= 4
        ? Math.min(400, policy.largeToolPreviewChars)
        : policy.largeToolPreviewChars,
      tailChars: recoveryLevel >= 4
        ? Math.min(200, policy.largeToolTailChars)
        : policy.largeToolTailChars,
      triggerChars: recoveryLevel >= 4 ? 800 : policy.largeToolTriggerChars,
    });
    keepMessages = skeleton.messages;
    if (skeleton.changed) {
      degraded = true;
      reason = recoveryLevel >= 4 ? 'tool_results_refs_only' : 'aggressive_keep_microcompact';
    }
    // Re-trim after skeletonize (usually not needed, but keeps invariant).
    keepMessages = trimKeepToLimits(keepMessages, budget);
  }

  if (recoveryLevel >= 5) {
    // Shrink to latest human anchor + trailing open-tool skeleton.
    let anchorIndex = -1;
    for (let index = keepMessages.length - 1; index >= 0; index -= 1) {
      if (isHumanUserMessage(keepMessages[index]!)) {
        anchorIndex = index;
        break;
      }
    }
    if (anchorIndex >= 0) {
      const anchor = keepMessages[anchorIndex]!;
      const tail = keepMessages.slice(anchorIndex + 1);
      // Keep only tool calls/results after anchor (protocol skeleton), drop other assistant prose if needed.
      const skeletonTail = tail.filter((message) => (
        toolUseIds(message).length > 0
        || hasToolResult(message)
        || message.role === 'assistant'
      ));
      keepMessages = [anchor, ...skeletonTail];
      const skeletonized = skeletonizeKeepToolResults(keepMessages, {
        headChars: 300,
        tailChars: 120,
        triggerChars: 400,
      });
      keepMessages = trimKeepToLimits(skeletonized.messages, {
        ...budget,
        // At L5, force a tighter budget: half of keepBudget, min 1k.
        keepBudgetTokens: Math.max(1_024, Math.floor(budget.keepBudgetTokens / 2)),
        maxRecentMessages: Math.min(budget.maxRecentMessages, 8),
        maxCompletedToolResults: Math.min(budget.maxCompletedToolResults, 2),
      });
      degraded = true;
      reason = 'anchor_plus_open_tool_skeleton';
    }
  }

  const keepTokens = estimateContextMessagesTokens(keepMessages);
  return {
    systemMessages: [...baseSplit.systemMessages],
    oldMessages,
    keepMessages,
    keepBudgetTokens: budget.keepBudgetTokens,
    keepTokens,
    recoveryLevel,
    degraded,
    reason,
  };
}

export function estimateGoalKeepTokens(messages: readonly CompactionMessage[]): number {
  return estimateContextMessagesTokens(messages);
}

export function estimateGoalKeepTextTokens(text: unknown): number {
  return estimateContextTextTokens(text);
}
