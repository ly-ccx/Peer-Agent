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
  '你是对话摘要专家。请将以下对话历史压缩为详细摘要，保留关键信息：用户意图、重要决策、技术概念、文件变更、错误修复、待办事项。特别要详细记录用户的具体执行动作与操作步骤——用户要求做了什么、实际改动了哪些文件、命令/操作执行到哪一步、当前停在何处——因为原文已全量压缩、不再保留，连续性完全依赖本摘要承载。输出纯文本，不要用 markdown。';

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
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding user feedback and changing intent.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request. CRITICAL — record the user's concrete execution actions and operation steps in detail: what the user asked to do, which files were actually changed, what commands/operations were run and to which step they progressed, and exactly where things currently stand. The original conversation is fully compacted and NOT retained, so continuity depends entirely on this summary capturing those execution details.
9. Optional Next Step: List the next step related to the most recent work. Include direct quotes from the most recent conversation.

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

function findCurrentTurnStart(messages: readonly CompactionMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isHumanUserMessage(messages[index]!)) return index;
  }
  return -1;
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
  options: { readonly preserveLatestUserTurn?: boolean; readonly keepRecentCount?: number } = {},
): CompactionSplit<TMessage> {
  const systemMessages = messages.filter((message) => message.role === 'system');
  const conversation = messages.filter((message) => message.role !== 'system');
  const currentTurnStart = options.preserveLatestUserTurn ? findCurrentTurnStart(conversation) : -1;

  let keepMessages: TMessage[];
  let oldMessages: TMessage[];
  if (currentTurnStart >= 0) {
    const currentTail = conversation.slice(currentTurnStart + 1);
    const unclosedTailStart = findUnclosedToolTailStart(currentTail);
    keepMessages = [conversation[currentTurnStart]!, ...currentTail.slice(unclosedTailStart)];
    oldMessages = [...conversation.slice(0, currentTurnStart), ...currentTail.slice(0, unclosedTailStart)];
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
