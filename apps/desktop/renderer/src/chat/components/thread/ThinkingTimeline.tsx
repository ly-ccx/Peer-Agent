import type { I18nRuntime, TranslationKey } from '@peer-agent/i18n';
import type { ThinkingProcess, ToolCard } from '@peer-agent/protocol';
import { parseInteractionToolViewFromCandidates } from '../../state/interactionToolView';
import { InteractionToolCard } from './InteractionToolCard';

function parseToolCardInteractionView(tool: ToolCard) {
  return parseInteractionToolViewFromCandidates(
    [tool.toolId, tool.displayName, tool.capabilityId],
    [tool.inputArguments, tool.resultContent, tool.resultSummary],
  );
}

function renderToolResult(tool: ToolCard) {
  const interactionView = parseToolCardInteractionView(tool);
  if (interactionView) {
    return <InteractionToolCard view={interactionView} className="timeline-interaction-card" />;
  }

  const summary = tool.resultSummary || '';
  const content = tool.resultContent || '';
  const hasErrors = tool.errorCount || tool.warningCount;
  const badge = [
    tool.errorCount ? `errors ${tool.errorCount}` : '',
    tool.warningCount ? `warnings ${tool.warningCount}` : '',
  ].filter(Boolean).join(' · ');

  if (!summary && !content && !hasErrors) return null;

  if (summary && !content) {
    if (summary.length <= 120) {
      return <p className="tool-result-summary">{summary}{badge ? ` · ${badge}` : ''}</p>;
    }
    return (
      <details className="tool-result-details">
        <summary className="tool-result-summary">
          {summary.slice(0, 60)}…
          {badge ? ` · ${badge}` : ''}
        </summary>
        <pre className="tool-result-content">{summary}</pre>
      </details>
    );
  }

  return (
    <details className="tool-result-details">
      <summary className="tool-result-summary">
        {summary || (content.length > 60 ? `${content.slice(0, 60)}…` : content)}
        {badge ? ` · ${badge}` : ''}
      </summary>
      {content ? <pre className="tool-result-content">{content}</pre> : null}
    </details>
  );
}

/**
 * 将 inputArguments 提取为可读字符串。
 * 只要 inputArguments 中含有 command 或 description 字段就展示。
 */
function extractInputArgumentsText(tool: ToolCard): string | null {
  const args = tool.inputArguments;
  if (args === null || args === undefined) return null;

  if (typeof args === 'object') {
    const record = args as Record<string, unknown>;
    const command = typeof record.command === 'string' && record.command.length > 0 ? record.command : null;
    const description = typeof record.description === 'string' && record.description.length > 0 ? record.description : null;
    if (command || description) {
      const parts: string[] = [];
      if (description) parts.push(`// ${description}`);
      if (command) parts.push(command);
      return parts.join('\n');
    }
  }
  return null;
}

function renderToolInput(_label: string, tool: ToolCard) {
  const text = extractInputArgumentsText(tool);
  if (!text) return null;
  return (
    <div className="timeline-tool-input">
      <pre>{text}</pre>
    </div>
  );
}

/**
 * 内置 client local 工具的标题走 i18n（按稳定 capabilityId 映射），跟界面 locale 一致。
 * displayName 是后端 ClientRuntimeLocalToolContract 注入的固定中文文案，不能直接翻译，
 * 只作 fallback；local.skill.* 的 displayName 是用户技能名（动态），不在表里、自然走 fallback。
 */
const TOOL_TITLE_I18N_KEY: Record<string, TranslationKey> = {
  'local.shell.exec': 'chat.tool.localShellExec',
  'local.shell.stop': 'chat.tool.localShellStop',
};

function resolveToolTitle(tool: ToolCard, i18n: I18nRuntime): string {
  const key = tool.capabilityId ? TOOL_TITLE_I18N_KEY[tool.capabilityId] : undefined;
  if (key) return i18n.t(key);
  return tool.displayName ?? tool.toolId ?? tool.toolCallId;
}

/**
 * Client local tool 的细粒度生命周期阶段。如果存在就优先显示，让用户能看到
 * dispatching / acked / running / waiting_user_consent 这些过渡态，而不是只
 * 看到 ToolCard.status 折叠后的 running/completed/error。
 */
function renderToolStatusBadge(tool: ToolCard, fallback: string): string {
  return tool.clientToolStatus ?? fallback;
}

/**
 * 流式 stdout / stderr 输出区。仅在字段非空时渲染——避免给非 client tool 的卡片
 * 出现空白 pre。stdout 长输出用 max-height + overflow:auto 兜底防止撑爆视图。
 *
 * 增量 append 不重建 DOM：React 通过 key 保留 <pre> 节点，setState 时只 update
 * textContent，没有 layout 抖动；CSS 的 white-space:pre 让换行/空格保留原样。
 */
function renderToolStream(label: string, content: string | undefined, kind: 'stdout' | 'stderr') {
  if (!content) return null;
  const preview = content.length > 80 ? `${content.slice(0, 80)}…` : content;
  return (
    <details className={`timeline-tool-${kind}`}>
      <summary className="timeline-tool-stream-label">{label} · {preview.split('\n')[0]}</summary>
      <pre>{content}</pre>
    </details>
  );
}

function countRenderedToolCalls(iterations: ThinkingProcess['iterations']) {
  if (!Array.isArray(iterations)) return 0;
  return iterations.reduce((sum, iteration) => {
    const toolCards = Array.isArray(iteration.toolCards) ? iteration.toolCards : [];
    return sum + toolCards.length;
  }, 0);
}

export function ThinkingTimeline({
  thinking,
  i18n,
}: {
  readonly thinking: ThinkingProcess;
  readonly i18n: I18nRuntime;
}) {
  const iterations: ThinkingProcess['iterations'] = Array.isArray(thinking.iterations) ? thinking.iterations : [];
  const hasIterations = iterations.length > 0;
  const status = thinking.status ?? 'completed';
  const actualToolCallCount = thinking.totalToolCalls ?? countRenderedToolCalls(iterations);

  return (
    <div className="thinking-timeline">
      <div className="timeline-summary">
        <span>{status}</span>
        <span>{i18n.t('chat.timeline.toolCount', { count: actualToolCallCount })}</span>
      </div>
      {!hasIterations ? <p className="empty-inline">{i18n.t('chat.timeline.noContent')}</p> : null}
      {iterations.map((iteration, iterationIndex) => {
        const displayNumber = iterationIndex + 1;
        // React key 用 (executionUuid, iteration) 复合身份：治本后不同 execution 的
        // 同序号轮次会并存,单用 iteration 会 key 冲突;显示序号用连续的数组下标。
        const iterationKey = `${iteration.executionUuid ?? 'x'}#${iteration.iteration ?? iterationIndex}`;
        const toolCards: readonly ToolCard[] = Array.isArray(iteration.toolCards) ? iteration.toolCards : [];
        return (
          <section key={iterationKey} className="timeline-iteration">
            <header>
              <strong className={iteration.status === 'thinking' || iteration.status === 'tool_calling' ? 'za-streaming-text' : undefined}>{iteration.label && !/^正在/.test(iteration.label) ? iteration.label : i18n.t('chat.timeline.iteration', { iteration: displayNumber })}</strong>
              <span>{iteration.status ?? 'completed'}</span>
            </header>
            {iteration.thinkingContent && !/^正在思考/.test(iteration.thinkingContent) ? <p>{iteration.thinkingContent}</p> : null}
            {toolCards.map((tool, toolIndex) => {
              const steps = Array.isArray(tool.steps) ? tool.steps : [];
              const toolId = tool.toolCallId ?? tool.toolId ?? `tool_${displayNumber}_${toolIndex}`;
              const toolStatus = tool.status ?? 'completed';
              return (
                <article key={toolId} className={`timeline-tool ${toolStatus}`}>
                  <div>
                    <strong>{resolveToolTitle(tool, i18n)}</strong>
                    <span>{renderToolStatusBadge(tool, toolStatus)}</span>
                  </div>
                  {renderToolInput(i18n.t('chat.timeline.toolInput'), tool)}
                  {steps.length > 0 ? (
                    <ol>
                      {steps.map((step) => (
                        <li key={`${toolId}-${step.step}`}>
                          <span>{step.title}</span>
                          <small>{step.status}</small>
                        </li>
                      ))}
                    </ol>
                  ) : null}
                  {renderToolStream(i18n.t('chat.timeline.toolStdout'), tool.stdout, 'stdout')}
                  {renderToolStream(i18n.t('chat.timeline.toolStderr'), tool.stderr, 'stderr')}
                  {renderToolResult(tool)}
                </article>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}
