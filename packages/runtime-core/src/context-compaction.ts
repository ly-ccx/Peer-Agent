export type CompactionMessage = Readonly<{
  role: string;
  content?: unknown;
  toolCallId?: string;
  tool_call_id?: string;
  toolCalls?: readonly Readonly<{ id?: string }>[];
  tool_calls?: readonly Readonly<{ id?: string }>[];
  _compaction?: unknown;
}>;

export type CompactionMethod = 'llm' | 'structured' | 'fallback_drop';

export const COMPACTION_SUMMARY_SYSTEM_PROMPT =
  '你是上下文交接专家。请把历史压缩成可验证、可继续执行的交接清单。必须区分事实与计划，稳定保留：当前目标与验收标准；用户最近要求及关键原话；已确认、已否决（含原因）和待确认的决策；已读取、已修改、已创建的文件；已执行命令及真实结果；错误、失败尝试与原因；当前运行状态；精确下一步；Evidence、artifact ref 和可重新读取位置；已经完成且不应重复执行的工作。没有证据的事项不得写成已完成。原文压缩后不再保留，连续性完全依赖本摘要承载。输出纯文本，不要用 markdown。';

export const COMPACTION_SUMMARY_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like file names, full code snippets, function signatures, file edits, etc
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that may have led to a change in your approach.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Include a summary of why this file read or edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. Decisions: Separate confirmed, rejected (with reasons), and pending decisions. Never collapse a rejected option into the final choice.
7. All user messages: List ALL user messages that are not tool results. Quote the most recent requirements that affect current work.
8. Evidence and recovery: Preserve Tool Result/Evidence/artifact refs, rerunnable retrieval hints, and exact locations that can be read again. Do not present an unverified plan as completed work.
9. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
10. Current Work: Describe in detail precisely what was being worked on immediately before this summary request. CRITICAL — record the user's concrete execution actions and operation steps in detail: what the user asked to do, which files were actually changed, what commands/operations were run and their real outcomes, and exactly where things currently stand. The original conversation is fully compacted and NOT retained, so continuity depends entirely on this summary capturing those execution details.
11. Do Not Repeat: List completed, rejected, or failed work that must not be rerun without new evidence or a changed requirement.
12. Exact Next Step: State the next executable step, its success criterion, and any blocker. Include direct quotes from the most recent conversation.

CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response.`;

export function formatCompactionMessagesForSummary(messages: readonly CompactionMessage[]): string {
  return messages
    .map((message) => {
      const content = typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content);
      return `[${message.role}]: ${content}`;
    })
    .join('\n\n');
}

export interface CompactionSplit<TMessage extends CompactionMessage> {
  readonly systemMessages: readonly TMessage[];
  readonly oldMessages: readonly TMessage[];
  readonly keepMessages: readonly TMessage[];
}

export interface CompactionSummaryResult {
  readonly method: CompactionMethod;
  readonly summary: string;
  readonly fallbackReason?: 'llm_unavailable' | 'llm_failed' | 'structured_empty';
  readonly fallbackDetail?: string;
}

export interface CompactionSummaryCascadeOptions<TMessage extends CompactionMessage> {
  readonly oldMessages: readonly TMessage[];
  readonly summarizeWithLlm?: (messages: readonly TMessage[]) => Promise<string | null | undefined>;
  readonly summarizeStructurally: (messages: readonly TMessage[]) => string | null | undefined;
  readonly fallbackSummary?: string;
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

function findRecentTurnStart(
  messages: readonly CompactionMessage[],
  turnCount: number,
): number {
  let remaining = Math.max(1, Math.floor(turnCount));
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (!isHumanUserMessage(messages[index]!)) continue;
    remaining -= 1;
    if (remaining === 0) return index;
  }
  return messages.length > 0 ? 0 : -1;
}

function findUnclosedToolTailStart(messages: readonly CompactionMessage[]): number {
  const pending = new Map<string, number>();
  messages.forEach((message, index) => {
    for (const id of toolUseIds(message)) pending.set(id, index);
    for (const id of toolResultIds(message)) pending.delete(id);
  });
  return pending.size === 0 ? messages.length : Math.min(...pending.values());
}

function expandKeepForToolContinuity<TMessage extends CompactionMessage>(
  keepMessages: readonly TMessage[],
  oldMessages: readonly TMessage[],
): { keepMessages: TMessage[]; oldMessages: TMessage[] } {
  const keep = [...keepMessages];
  const old = [...oldMessages];
  while (keep.length > 0 && hasToolResult(keep[0]!) && old.length > 0) {
    const previous = old.pop()!;
    keep.unshift(previous);
    if (toolUseIds(previous).length > 0) break;
  }
  return { keepMessages: keep, oldMessages: old };
}

/**
 * Host-neutral form of Desktop's compaction split rules. System messages are kept
 * separately; automatic preflight preserves the newest human turn; and a split
 * never leaves an orphan tool result or an unfinished tool call in summarized history.
 */
export function splitMessagesForCompaction<TMessage extends CompactionMessage>(
  messages: readonly TMessage[],
  options: {
    readonly preserveLatestUserTurn?: boolean;
    readonly preserveRecentTurns?: number;
    readonly keepRecentCount?: number;
  } = {},
): CompactionSplit<TMessage> {
  const systemMessages = messages.filter((message) => message.role === 'system');
  const conversation = messages.filter((message) => message.role !== 'system');
  const recentTurnCount = options.preserveLatestUserTurn
    ? Math.max(1, Math.floor(options.preserveRecentTurns ?? 1))
    : 0;
  const recentTurnStart = recentTurnCount > 0
    ? findRecentTurnStart(conversation, recentTurnCount)
    : -1;
  const hasHumanTurn = conversation.some(isHumanUserMessage);

  let keepMessages: TMessage[];
  let oldMessages: TMessage[];
  if (recentTurnStart >= 0 && hasHumanTurn) {
    const recentTail = conversation.slice(recentTurnStart);
    if (recentTurnCount === 1) {
      const currentTail = recentTail.slice(1);
      const unclosedTailStart = findUnclosedToolTailStart(currentTail);
      keepMessages = [recentTail[0]!, ...currentTail.slice(unclosedTailStart)];
      oldMessages = [...conversation.slice(0, recentTurnStart), ...currentTail.slice(0, unclosedTailStart)];
    } else {
      keepMessages = recentTail;
      oldMessages = conversation.slice(0, recentTurnStart);
    }
  } else {
    const requested = Math.max(0, Math.floor(options.keepRecentCount ?? 0));
    const keepCount = Math.min(requested, conversation.length);
    keepMessages = keepCount > 0 ? conversation.slice(-keepCount) : [];
    oldMessages = keepCount > 0 ? conversation.slice(0, -keepCount) : [...conversation];
  }

  const safe = expandKeepForToolContinuity(keepMessages, oldMessages);
  return { systemMessages, ...safe };
}

/** Desktop's summary preference order, expressed behind a host-provided model port. */
export async function runCompactionSummaryCascade<TMessage extends CompactionMessage>(
  options: CompactionSummaryCascadeOptions<TMessage>,
): Promise<CompactionSummaryResult> {
  let fallbackReason: CompactionSummaryResult['fallbackReason'] = options.summarizeWithLlm
    ? 'llm_failed'
    : 'llm_unavailable';
  let fallbackDetail: string | undefined;

  if (options.summarizeWithLlm) {
    try {
      const summary = (await options.summarizeWithLlm(options.oldMessages))?.trim();
      if (summary) return { method: 'llm', summary };
      fallbackDetail = 'LLM summarizer returned an empty summary.';
    } catch (error) {
      fallbackDetail = error instanceof Error ? error.message : String(error);
    }
  }

  const structured = options.summarizeStructurally(options.oldMessages)?.trim();
  if (structured) {
    return { method: 'structured', summary: structured, fallbackReason, fallbackDetail };
  }

  fallbackReason = 'structured_empty';
  return {
    method: 'fallback_drop',
    summary: options.fallbackSummary?.trim() || 'Earlier conversation was removed because no safe summary could be produced.',
    fallbackReason,
    fallbackDetail,
  };
}

export type CompactionStrategyResult<TMessage extends CompactionMessage> = Readonly<{
  compacted: boolean;
  systemMessages: readonly TMessage[];
  keepMessages: readonly TMessage[];
  oldMessages: readonly TMessage[];
  summary?: string;
  handoffContent?: string;
  method?: CompactionSummaryResult['method'];
  fallbackReason?: CompactionSummaryResult['fallbackReason'];
  fallbackDetail?: string;
}>;

/**
 * Shared strategy boundary used by both Desktop and CLI/TUI. Hosts provide the
 * LLM/structural summarizers and handoff formatting, while split safety and
 * fallback ordering remain owned by runtime-core.
 */
export async function compactMessagesWithSummaryStrategy<TMessage extends CompactionMessage>(
  options: Readonly<{
    messages: readonly TMessage[];
    preserveLatestUserTurn?: boolean;
    preserveRecentTurns?: number;
    keepRecentCount?: number;
    summarizeWithLlm?: (oldMessages: readonly TMessage[]) => Promise<string | null | undefined>;
    summarizeStructurally: (oldMessages: readonly TMessage[]) => string | null | undefined;
    buildHandoffContent: (summary: string, oldCount: number) => string;
    fallbackSummary?: string;
  }>,
): Promise<CompactionStrategyResult<TMessage>> {
  const split = splitMessagesForCompaction(options.messages, {
    preserveLatestUserTurn: options.preserveLatestUserTurn,
    preserveRecentTurns: options.preserveRecentTurns,
    keepRecentCount: options.keepRecentCount,
  });
  if (split.oldMessages.length === 0) {
    return {
      compacted: false,
      systemMessages: split.systemMessages,
      keepMessages: split.keepMessages,
      oldMessages: split.oldMessages,
    };
  }
  const cascade = await runCompactionSummaryCascade({
    oldMessages: split.oldMessages,
    summarizeWithLlm: options.summarizeWithLlm,
    summarizeStructurally: options.summarizeStructurally,
    fallbackSummary: options.fallbackSummary,
  });
  const summary = cascade.summary.trim();
  return {
    compacted: true,
    systemMessages: split.systemMessages,
    keepMessages: split.keepMessages,
    oldMessages: split.oldMessages,
    summary,
    handoffContent: options.buildHandoffContent(summary, split.oldMessages.length),
    method: cascade.method,
    fallbackReason: cascade.fallbackReason,
    fallbackDetail: cascade.fallbackDetail,
  };
}
