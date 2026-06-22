import { useEffect, useState } from 'react';
import { parseInteractionToolViewFromCandidates } from '../../state/interactionToolView';
import { groupSegments } from '../../state/streamSegments';
import type {
  ContentSegment,
  ToolCallLegacy,
  CompactionMeta,
  ToolProgress,
} from '../../state/types';
import { MarkdownMessage } from '../markdown/MarkdownMessage';
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

export function AssistantContent({ segments, content, isStreaming, toolProgress, isZh }: {
  readonly segments?: ContentSegment[];
  readonly content: string;
  readonly isStreaming: boolean;
  readonly toolProgress?: ToolProgress | null;
  readonly isZh: boolean;
}) {
  if (!segments?.length) {
    if (content || toolProgress || isStreaming) {
      return (
        <div className="assistant-segments">
          {content ? <MarkdownMessage content={content} /> : null}
          {toolProgress ? <ToolProgressInline progress={toolProgress} isZh={isZh} /> : null}
          {!toolProgress && isStreaming ? <span className="streaming-cursor">▍</span> : null}
        </div>
      );
    }
    return null;
  }

  const groups = groupSegments(segments);
  const lastGroup = groups[groups.length - 1];
  // 流式期间始终保留一个“还在运行”的指示，避免工具执行间隙/文本结束等待下一步时
  // 光标消失造成“卡住”的错觉。仅当末尾组本身已有 active 视觉（工具执行中的工具组、
  // active 的思考文本组）时才省略底部光标，避免重复闪烁。
  const lastGroupHasActiveIndicator = Boolean(
    lastGroup &&
    ((lastGroup.type === 'tool-call-group' && lastGroup.calls.some((c) => c.result === undefined)) ||
      lastGroup.type === 'thinking'),
  );
  const showCursor = isStreaming && !toolProgress && !lastGroupHasActiveIndicator;

  return (
    <div className="assistant-segments">
      {groups.map((group, i) => {
        if (group.type === 'text') {
          const afterTools = i > 0 && groups[i - 1].type === 'tool-call-group';
          return (
            <div key={i} className={afterTools ? 'segment-text-after-tools' : undefined}>
              <MarkdownMessage content={group.content} />
            </div>
          );
        }
        if (group.type === 'thinking') {
          return (
            <ThinkingTextSection
              key={i}
              content={group.content}
              isActive={isStreaming && i === groups.length - 1}
              isZh={isZh}
            />
          );
        }
        return (
          <ThinkingSection
            key={i}
            toolCalls={group.calls}
            isActive={isStreaming && group.calls.some((c) => c.result === undefined)}
            isZh={isZh}
          />
        );
      })}
      {toolProgress ? <ToolProgressInline progress={toolProgress} isZh={isZh} /> : null}
      {showCursor ? <span className="streaming-cursor">▍</span> : null}
    </div>
  );
}

function ThinkingTextSection({ content, isActive, isZh }: { readonly content: string; readonly isActive: boolean; readonly isZh: boolean }) {
  const [expanded, setExpanded] = useState(isActive);
  const label = isActive
    ? (isZh ? '深度思考中...' : 'Thinking...')
    : (isZh ? '深度思考' : 'Thinking');

  return (
    <div className={`thinking-section ${isActive ? 'active' : 'done'}`}>
      <button type="button" className="thinking-toggle" onClick={() => setExpanded(!expanded)}>
        <span className="thinking-indicator" aria-hidden="true">
          {isActive ? (
            <svg className="thinking-indicator-svg" width="13" height="13" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.3" />
              <path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="9" fill="currentColor" />
            </svg>
          )}
        </span>
        <span className="thinking-label">{label}</span>
        <svg className="thinking-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={expanded ? undefined : { transform: 'rotate(-90deg)' }}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {expanded ? (
        <div className="thinking-body thinking-text">
          <MarkdownMessage content={content} />
        </div>
      ) : null}
    </div>
  );
}

function ThinkingSection({ toolCalls, isActive, isZh }: { readonly toolCalls: ToolCallLegacy[]; readonly isActive: boolean; readonly isZh: boolean }) {
  const hasInteractionCall = toolCalls.some((tc) => parseToolCallInteractionView(tc) !== null);
  const shouldAutoExpand = isActive || hasInteractionCall;
  const [expanded, setExpanded] = useState(shouldAutoExpand);

  useEffect(() => {
    if (shouldAutoExpand) setExpanded(true);
  }, [shouldAutoExpand]);

  const doneCount = toolCalls.filter((tc) => tc.result !== undefined).length;
  const total = toolCalls.length;
  const label = isActive
    ? (isZh ? `思考中... (${doneCount}/${total})` : `Thinking... (${doneCount}/${total})`)
    : (isZh ? `${total} 次工具调用` : `${total} tool call${total > 1 ? 's' : ''}`);

  return (
    <div className={`thinking-section ${isActive ? 'active' : 'done'}`}>
      <button type="button" className="thinking-toggle" onClick={() => setExpanded(!expanded)}>
        <span className="thinking-indicator" aria-hidden="true">
          {isActive ? (
            <svg className="thinking-indicator-svg" width="13" height="13" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.3" />
              <path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="9" fill="currentColor" />
            </svg>
          )}
        </span>
        <span className="thinking-label">{label}</span>
        <svg className="thinking-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={expanded ? undefined : { transform: 'rotate(-90deg)' }}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {expanded ? (
        <div className="thinking-body">
          {toolCalls.map((tc, i) => (
            <ToolCallCard key={i} tc={tc} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function parseToolCallInteractionView(tc: ToolCallLegacy) {
  return parseInteractionToolViewFromCandidates(
    [tc.tool, tc.displayName],
    [tc.args, tc.result],
  );
}

function ToolCallCard({ tc }: { readonly tc: ToolCallLegacy }) {
  const [expanded, setExpanded] = useState(false);

  // request_user_input：渲染为「问题 + 可点击选项 + 等待你输入」的交互卡，
  // 而不是裸露 JSON。见 Goal 模式运行时闸门设计。
  const interactionView = parseToolCallInteractionView(tc);
  if (interactionView) {
    return <InteractionToolCard view={interactionView} />;
  }

  const label = tc.tool === 'bash'
    ? (tc.args.command as string)
    : tc.tool === 'read_file'
      ? `read ${tc.args.path}`
      : tc.tool === 'edit_file'
        ? `edit ${tc.args.path}`
        : tc.tool === 'write_file'
          ? `write ${tc.args.path}`
          // displayName 是后端 Runtime Projection 注入的展示文案（MCP 工具为
          // 「服务名: 工具名」）。其它工具优先用它做标题，缺省时才回退到裸 capability 名，
          // 避免出现 mcp__server__tool 这类裸名（即「标题不见了」的现象）。
          : (tc.displayName ?? tc.tool);
  const isSynthetic = tc.synthetic === true;
  const isDone = tc.result !== undefined && !isSynthetic;

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
        <span className="tool-call-label">{label}</span>
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
          {(compaction as unknown as Record<string, unknown>).summary
            ? (compaction as unknown as Record<string, unknown>).summary as string
            : (isZh
              ? `${compaction.originalMessageCount} 条早期消息已被压缩。\n\n压缩前: ${(compaction.beforeTokens / 1000).toFixed(0)}k tokens\n压缩后: ${(compaction.afterTokens / 1000).toFixed(0)}k tokens\n方法: ${methodLabel}${fallbackReasonLabel ? `\n未走 LLM 原因: ${fallbackReasonLabel}` : ''}${compaction.fallbackDetail ? `\n明细: ${compaction.fallbackDetail}` : ''}`
              : `${compaction.originalMessageCount} earlier messages compacted.\n\nBefore: ${(compaction.beforeTokens / 1000).toFixed(0)}k tokens\nAfter: ${(compaction.afterTokens / 1000).toFixed(0)}k tokens\nMethod: ${methodLabel}${fallbackReasonLabel ? `\nFallback reason: ${fallbackReasonLabel}` : ''}${compaction.fallbackDetail ? `\nDetail: ${compaction.fallbackDetail}` : ''}`)}
        </div>
      ) : null}
    </div>
  );
}
