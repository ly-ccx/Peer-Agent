import { memo, useEffect, useMemo, useState } from 'react';
import { useConversationToolProgress } from '../../hooks/useConversationState';
import { parseInteractionToolViewFromCandidates } from '../../state/interactionToolView';
import { groupSegments, splitFinalTextGroup } from '../../state/streamSegments';
import { formatDuration } from '../../state/format';
import {
  previewInlineText,
  windowProcessingGroups,
  windowProcessingText,
} from '../../state/processingWindow';
import type {
  ContentSegment,
  ToolCallLegacy,
  CompactionMeta,
  ToolProgress,
  SegmentGroup,
} from '../../state/types';
import { MarkdownMessage } from '../markdown/MarkdownMessage';
import { BatchSearchToolCard } from './BatchSearchToolCard';
import { buildBatchSearchView } from '../../state/batchSearchLaneView';
import { neutralizeToolCallSyntaxForDisplay } from '../../state/historicalLocalRecord';
import { InteractionToolCard } from './InteractionToolCard';

function toolProgressLabel(
  progress: ToolProgress,
  isZh: boolean,
): string {
  const file = progress.path ? progress.path.split('/').pop() || progress.path : null;
  const verbZh =
    progress.tool === 'edit_file' ? '编辑'
      : progress.tool === 'write_file' ? '写入'
        : progress.tool === 'read_file' ? '读取'
          : '准备';
  const verbEn =
    progress.tool === 'edit_file' ? 'Editing'
      : progress.tool === 'write_file' ? 'Writing'
        : progress.tool === 'read_file' ? 'Reading'
          : 'Preparing';
  const lines = progress.receivedLines;
  if (isZh) {
    const target = file ? ` ${file}` : ` ${progress.tool}`;
    return lines > 0 ? `正在${verbZh}${target} · 已接收 ${lines} 行` : `正在${verbZh}${target}…`;
  }
  const target = file ? ` ${file}` : ` ${progress.tool}`;
  return lines > 0 ? `${verbEn}${target} · ${lines} lines received` : `${verbEn}${target}…`;
}

export function ToolProgressInline({ progress, isZh }: { readonly progress: ToolProgress; readonly isZh: boolean }) {
  return (
    <div className="tool-progress-inline">
      <span className="tool-progress-spinner" aria-hidden="true" />
      <div className="tool-progress-body">
        {toolProgressLabel(progress, isZh)}
      </div>
    </div>
  );
}

function LiveToolProgress({
  conversationId,
  showCursor,
  isZh,
}: {
  readonly conversationId: string | null;
  readonly showCursor: boolean;
  readonly isZh: boolean;
}) {
  const progress = useConversationToolProgress(conversationId, true);
  if (progress) return <ToolProgressInline progress={progress} isZh={isZh} />;
  return showCursor ? <span className="streaming-cursor">▍</span> : null;
}

function useAutoCollapsingExpanded(isActive: boolean) {
  // 流式输出和工具调度期间保持展开，让用户持续看到正在发生什么；
  // 整条回复最终完成后再自动折叠。已完成的历史消息首次渲染时保持折叠。
  const [expanded, setExpanded] = useState(isActive);

  useEffect(() => {
    setExpanded(isActive);
  }, [isActive]);

  const toggleExpanded = () => {
    setExpanded((current) => !current);
  };

  return { expanded, toggleExpanded };
}

function buildProcessingSummary(groups: SegmentGroup[], durationMs: number | undefined, isZh: boolean): string {
  const prefix = isZh ? '已处理' : 'Processed';
  if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0) {
    return `${prefix} ${formatDuration(durationMs)}`;
  }

  const toolCallCount = groups.reduce(
    (count, group) => count + (group.type === 'tool-call-group' ? group.calls.length : 0),
    0,
  );
  if (toolCallCount > 0) {
    return isZh
      ? `${prefix} ${toolCallCount} 次工具调用`
      : `${prefix} ${toolCallCount} tool call${toolCallCount > 1 ? 's' : ''}`;
  }

  return prefix;
}

function AssistantContentImpl({
  conversationId,
  segments,
  content,
  isStreaming,
  durationMs,
  isZh,
}: {
  readonly conversationId: string | null;
  readonly segments?: ContentSegment[];
  readonly content: string;
  readonly isStreaming: boolean;
  readonly durationMs?: number;
  readonly isZh: boolean;
}) {
  const groups = useMemo(
    () => (segments?.length ? groupSegments(segments) : []),
    [segments],
  );
  const completedSplit = useMemo(
    () => (isStreaming || groups.length === 0 ? undefined : splitFinalTextGroup(groups)),
    [groups, isStreaming],
  );

  if (!segments?.length) {
    if (content || isStreaming) {
      return (
        <div className="assistant-segments">
          {content ? <MarkdownMessage content={content} /> : null}
          {isStreaming ? (
            <LiveToolProgress conversationId={conversationId} showCursor={true} isZh={isZh} />
          ) : null}
        </div>
      );
    }
    return null;
  }

  const processingSummary = buildProcessingSummary(groups, durationMs, isZh);
  const hasProcessingGroups = groups.some(isProcessingGroup);
  // 流式期间完整展示原始时间线；完成后只把最后正文留在折叠区外。
  const timelineGroups = completedSplit?.historyGroups ?? groups;
  const finalTextGroup = completedSplit?.finalTextGroup;
  // 交互卡（request_user_input）需要用户点击，单独抽出、始终渲染在折叠面板外。
  const interactionCalls = groups.flatMap((group) =>
    group.type === 'tool-call-group'
      ? group.calls.filter((tc) => parseToolCallInteractionView(tc))
      : [],
  );
  // 活跃态只跟随整条回复的流式生命周期，避免中间段类型切换造成展开/折叠抖动。
  const processingIsActive = isStreaming && hasProcessingGroups;
  const lastGroup = groups[groups.length - 1];
  // 流式期间始终保留一个“还在运行”的指示，避免工具执行间隙/文本结束等待下一步时
  // 光标消失造成“卡住”的错觉。仅当末尾组本身已有 active 视觉（工具执行中的工具组、
  // active 的思考文本组）时才省略底部光标，避免重复闪烁。
  const lastGroupHasActiveIndicator = Boolean(
    lastGroup &&
    ((lastGroup.type === 'tool-call-group' && lastGroup.calls.some((c) => c.result === undefined)) ||
      lastGroup.type === 'thinking'),
  );
  const showCursor = !lastGroupHasActiveIndicator;

  return (
    <div className="assistant-segments">
      {hasProcessingGroups && timelineGroups.length > 0 ? (
        <ProcessingDetailsSection
          groups={timelineGroups}
          isActive={processingIsActive}
          label={processingSummary}
          isZh={isZh}
        />
      ) : null}
      {finalTextGroup ? (
        <div className="segment-text-after-tools">
          <MarkdownMessage content={finalTextGroup.content} />
        </div>
      ) : !hasProcessingGroups ? (
        <TimelineGroups groups={groups} isZh={isZh} />
      ) : null}
      {/* 交互卡（request_user_input）始终渲染在折叠面板之外，折叠历史过程时也能看到并点击选项。 */}
      {interactionCalls.map((tc, idx) => (
        <ToolCallCard key={`interaction-${idx}`} tc={tc} isZh={isZh} />
      ))}
      {isStreaming ? (
        <LiveToolProgress conversationId={conversationId} showCursor={showCursor} isZh={isZh} />
      ) : null}
    </div>
  );
}

type ProcessingGroup = Extract<SegmentGroup, { type: 'thinking' | 'tool-call-group' }>;

function isProcessingGroup(group: SegmentGroup): group is ProcessingGroup {
  return group.type === 'thinking' || group.type === 'tool-call-group';
}

function ProcessingDetailsSection({ groups, isActive, label: completedLabel, isZh }: {
  readonly groups: SegmentGroup[];
  readonly isActive: boolean;
  readonly label: string;
  readonly isZh: boolean;
}) {
  const { expanded, toggleExpanded } = useAutoCollapsingExpanded(isActive);
  const [showAll, setShowAll] = useState(false);
  const processingWindow = useMemo(() => windowProcessingGroups(groups), [groups]);
  const visibleGroups = showAll ? groups : processingWindow.groups;
  const label = isActive
    ? (isZh ? '正在思考' : 'Thinking')
    : completedLabel;

  return (
    <div className={`thinking-section ${isActive ? 'active' : 'done'} ${expanded ? 'expanded' : 'collapsed'}`}>
      <button type="button" className="thinking-toggle" onClick={toggleExpanded}>
        <span className="thinking-label">{label}</span>
        <svg className="thinking-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={expanded ? undefined : { transform: 'rotate(-90deg)' }}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {expanded ? (
        <div className="thinking-body">
          {processingWindow.omittedCount > 0 ? (
            <button
              type="button"
              className="thinking-history-toggle"
              onClick={() => setShowAll((value) => !value)}
            >
              {showAll
                ? (isZh ? '收起较早过程' : 'Hide earlier activity')
                : (isZh
                    ? `展开较早的 ${processingWindow.omittedCount} 个过程`
                    : `Show ${processingWindow.omittedCount} earlier event${processingWindow.omittedCount === 1 ? '' : 's'}`)}
            </button>
          ) : null}
          <TimelineGroups groups={visibleGroups} isZh={isZh} />
        </div>
      ) : null}
    </div>
  );
}

function ThinkingTextGroup({ content, isZh }: {
  readonly content: string;
  readonly isZh: boolean;
}) {
  const [expandedContentAnchor, setExpandedContentAnchor] = useState<string | null>(null);
  const textWindow = useMemo(() => windowProcessingText(content), [content]);
  const contentAnchor = content.slice(0, 128);
  const showFullText = expandedContentAnchor === contentAnchor;
  const visibleContent = showFullText ? content : textWindow.content;

  return (
    <div className="thinking-text">
      {textWindow.omittedCharacterCount > 0 ? (
        <button
          type="button"
          className="thinking-history-toggle thinking-text-window-toggle"
          onClick={() => setExpandedContentAnchor(showFullText ? null : contentAnchor)}
        >
          {showFullText
            ? (isZh ? '收起完整思考' : 'Hide full thinking')
            : (isZh
                ? `展开更早的 ${textWindow.omittedCharacterCount.toLocaleString()} 个字符`
                : `Show ${textWindow.omittedCharacterCount.toLocaleString()} earlier characters`)}
        </button>
      ) : null}
      <MarkdownMessage content={neutralizeToolCallSyntaxForDisplay(visibleContent)} />
    </div>
  );
}

function TimelineGroups({ groups, isZh }: {
  readonly groups: SegmentGroup[];
  readonly isZh: boolean;
}) {
  return groups.map((group, groupIndex) => {
    if (group.type === 'thinking') {
      return (
        <ThinkingTextGroup
          key={`thinking-${groupIndex}`}
          content={group.content}
          isZh={isZh}
        />
      );
    }
    if (group.type === 'text') {
      return (
        <div key={`text-${groupIndex}`} className="segment-text-after-tools">
          <MarkdownMessage content={group.content} />
        </div>
      );
    }
    return group.calls.map((tc, callIndex) => {
      // 交互卡需要用户点击，始终在折叠面板外渲染；时间线内跳过以免重复。
      if (parseToolCallInteractionView(tc)) return null;
      return <ToolCallCard key={`tool-${groupIndex}-${callIndex}`} tc={tc} isZh={isZh} />;
    });
  });
}

function parseToolCallInteractionView(tc: ToolCallLegacy) {
  return parseInteractionToolViewFromCandidates(
    [tc.tool, tc.displayName],
    [tc.args, tc.result],
  );
}

function toolArgString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function fallbackToolCallLabel(tc: ToolCallLegacy, fallback: string): string {
  const value = fallback.trim();
  if (value) return value;
  if (tc.displayName?.trim()) return tc.displayName.trim();
  if (tc.tool?.trim()) return tc.tool.trim();
  if (tc.toolCallId?.trim()) return tc.toolCallId.trim();
  return 'tool call';
}

function ToolCallCard({ tc, isZh }: { readonly tc: ToolCallLegacy; readonly isZh: boolean }) {
  const [expanded, setExpanded] = useState(false);

  // request_user_input：渲染为「问题 + 可点击选项 + 等待你输入」的交互卡，
  // 而不是裸露 JSON。见 Goal 模式运行时闸门设计。
  const interactionView = parseToolCallInteractionView(tc);
  if (interactionView) {
    return <InteractionToolCard view={interactionView} />;
  }

  // batch_search：渲染为「分路逐条检索状态 + 聚合结果面板」，而不是裸 JSON。
  // 见 docs/design/batch-search-parallel-aggregation.md。
  // 入参兜底（方向 B）：若 args.queries 解析不出任何分路、也没有聚合结果，
  // 说明本次工具入参无效（常见于模型把 queries 写成畸形字符串），分路卡会卡在
  // 「0 路 · 检索中…」的误导态。此时不渲染分路卡，回退到通用工具卡显示裸参数，
  // 便于定位入参错误。args.queries 合法后重渲染会自动切回分路卡。
  if (tc.tool === 'batch_search') {
    const batchView = buildBatchSearchView(tc.args, tc.result);
    const hasBatchContent =
      batchView.lanes.length > 0 ||
      (batchView.aggregate != null && batchView.aggregate.matches.length > 0);
    if (hasBatchContent) {
      return <BatchSearchToolCard args={tc.args} result={tc.result} isZh={isZh} />;
    }
  }

  const label = tc.tool === 'bash'
    ? fallbackToolCallLabel(tc, toolArgString(tc.args, 'command') ?? '')
    : tc.tool === 'read_file'
      ? fallbackToolCallLabel(tc, toolArgString(tc.args, 'path') ? `read ${toolArgString(tc.args, 'path')}` : '')
      : tc.tool === 'edit_file'
        ? fallbackToolCallLabel(tc, toolArgString(tc.args, 'path') ? `edit ${toolArgString(tc.args, 'path')}` : '')
        : tc.tool === 'write_file'
          ? fallbackToolCallLabel(tc, toolArgString(tc.args, 'path') ? `write ${toolArgString(tc.args, 'path')}` : '')
          // displayName 是后端 Runtime Projection 注入的展示文案（MCP 工具为
          // 「服务名: 工具名」）。其它工具优先用它做标题，缺省时才回退到裸 capability 名，
          // 避免出现 mcp__server__tool 这类裸名（即「标题不见了」的现象）。
          : fallbackToolCallLabel(tc, tc.displayName ?? tc.tool ?? '');
  const isSynthetic = tc.synthetic === true;
  const isDone = tc.result !== undefined && !isSynthetic;
  const labelPreview = previewInlineText(label).content;

  return (
    <div className={`tool-call-card ${isSynthetic ? 'synthetic' : isDone ? 'done' : 'running'}`} onClick={() => setExpanded(!expanded)}>
      <div className="tool-call-header">
        <span className="tool-call-icon" aria-hidden="true">
          {isSynthetic ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="8" x2="12" y2="13" />
              <circle cx="12" cy="16.6" r="0.9" fill="currentColor" stroke="none" />
            </svg>
          ) : isDone ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="m5 12.5 4.5 4.5L19 7" />
            </svg>
          ) : (
            <svg className="tool-call-spinner-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <path d="M12 3a9 9 0 1 0 9 9" />
            </svg>
          )}
        </span>
        <span className="tool-call-label">{labelPreview}</span>
        <svg className="tool-call-expand" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={expanded ? undefined : { transform: 'rotate(-90deg)' }}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </div>
      {isSynthetic && expanded ? (
        <pre className="tool-call-output">这不是一次真实工具调用记录，而是历史 assistant 文本中出现的伪 Tool Call 标记；没有收到对应的工具结果。</pre>
      ) : null}
      {expanded && tc.result ? (
        <pre className="tool-call-output">{tc.result}</pre>
      ) : null}
    </div>
  );
}

export const AssistantContent = memo(AssistantContentImpl);

export function CompactionSummaryCard({ compaction, isZh }: { readonly compaction: CompactionMeta; readonly isZh: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const methodLabel =
    compaction.method === 'llm' ? 'LLM'
    : compaction.method === 'structural' ? (isZh ? '结构' : 'Structural')
    : (isZh ? '截断' : 'Truncated');
  const fallbackReasonLabel = compaction.fallbackReason
    ? (isZh
      ? ({
        no_provider: '未配置 LLM',
        llm_empty: 'LLM 返回空',
        llm_prompt_too_long: 'LLM 输入过长',
        llm_error: 'LLM 调用出错',
        llm_unavailable: 'LLM 不可用',
        circuit_breaker: 'LLM 已熔断',
      } as Record<string, string>)[compaction.fallbackReason] ?? compaction.fallbackReason
      : ({
        no_provider: 'No LLM provider',
        llm_empty: 'LLM returned empty',
        llm_prompt_too_long: 'LLM input too long',
        llm_error: 'LLM call error',
        llm_unavailable: 'LLM unavailable',
        circuit_breaker: 'LLM circuit broken',
      } as Record<string, string>)[compaction.fallbackReason] ?? compaction.fallbackReason)
    : null;
  const countLabel = compaction.deltaMessageCount !== undefined
    && compaction.deltaMessageCount !== compaction.originalMessageCount
    ? (isZh
      ? `本次 ${compaction.deltaMessageCount} / 累计 ${compaction.originalMessageCount} 条`
      : `${compaction.deltaMessageCount} this run / ${compaction.originalMessageCount} total`)
    : `${compaction.originalMessageCount} msgs`;

  return (
    <div className="compaction-summary-card">
      <button type="button" className="compaction-summary-toggle" onClick={() => setExpanded(!expanded)}>
        <span className="compaction-summary-label">
          {isZh ? '更早的对话（已压缩为摘要）' : 'Earlier conversation (compacted)'}
        </span>
        <span className="compaction-summary-count">
          {countLabel} · {methodLabel}
          {fallbackReasonLabel ? ` · ${fallbackReasonLabel}` : ''}
        </span>
        <svg className="tool-call-expand" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={expanded ? undefined : { transform: 'rotate(-90deg)' }}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {expanded ? (
        <div className="compaction-summary-body">
          {neutralizeToolCallSyntaxForDisplay((compaction as unknown as Record<string, unknown>).summary
            ? (compaction as unknown as Record<string, unknown>).summary as string
            : (isZh
              ? `${compaction.originalMessageCount} 条早期消息已被压缩。\n\n压缩前: ${(compaction.beforeTokens / 1000).toFixed(0)}k tokens\n压缩后: ${(compaction.afterTokens / 1000).toFixed(0)}k tokens\n方法: ${methodLabel}${fallbackReasonLabel ? `\n未走 LLM 原因: ${fallbackReasonLabel}` : ''}${compaction.fallbackDetail ? `\n明细: ${compaction.fallbackDetail}` : ''}`
              : `${compaction.originalMessageCount} earlier messages compacted.\n\nBefore: ${(compaction.beforeTokens / 1000).toFixed(0)}k tokens\nAfter: ${(compaction.afterTokens / 1000).toFixed(0)}k tokens\nMethod: ${methodLabel}${fallbackReasonLabel ? `\nFallback reason: ${fallbackReasonLabel}` : ''}${compaction.fallbackDetail ? `\nDetail: ${compaction.fallbackDetail}` : ''}`))}
        </div>
      ) : null}
    </div>
  );
}
