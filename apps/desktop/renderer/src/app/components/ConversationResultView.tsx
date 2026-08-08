import { useEffect, useMemo, useRef, useState } from 'react';
import type { GoalPlan, TaskOverviewItem } from '@peer-agent/protocol';
import { clientApi } from '../../clientApi';
import { MarkdownMessage } from '../../chat/components/markdown/MarkdownMessage';
import { loadConversationMessages } from '../../chat/state/conversationLoad';
import { contentFromSegments } from '../../chat/state/streamSegments';
import type { ChatMsg } from '../../chat/state/types';

/**
 * 工作台「查看结果」用的只读会话/执行内容展示。
 *
 * - Markdown：复用会话主路径 MarkdownMessage
 * - 定位：加载后滚动到与当前 Task/Plan 最相关的消息
 */
export function ConversationResultView({
  item,
  onAcceptResult,
}: {
  readonly item: TaskOverviewItem;
  readonly onAcceptResult?: (item: TaskOverviewItem) => void | Promise<void>;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<readonly ChatMsg[]>([]);
  const [plan, setPlan] = useState<GoalPlan | null>(null);
  const [accepting, setAccepting] = useState(false);
  const targetMsgRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setMessages([]);
    setPlan(null);

    void (async () => {
      try {
        const tasks: Promise<void>[] = [];

        if (item.source === 'goal_plan' && item.taskId) {
          tasks.push(
            clientApi.goalPlansGet({ planId: item.taskId }).then((detail) => {
              if (!cancelled) setPlan(detail ?? null);
            }),
          );
        }

        if (item.conversationId) {
          tasks.push(
            loadConversationMessages(String(item.conversationId)).then((loaded) => {
              if (!cancelled) setMessages(loaded.messages);
            }),
          );
        }

        await Promise.all(tasks);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [item.conversationId, item.source, item.taskId]);

  const progress = plan?.progress ?? null;
  const summaryProgress = progress ?? item.planProgress ?? null;
  const tasks = plan?.tasks ?? [];
  const canAccept = item.source === 'goal_plan' && typeof onAcceptResult === 'function';

  const targetMessageId = useMemo(
    () => findTaskRelatedMessageId(messages, item, plan),
    [messages, item, plan],
  );

  useEffect(() => {
    if (loading || !targetMessageId) return;
    const node = targetMsgRef.current;
    if (!node) return;
    const timer = window.setTimeout(() => {
      node.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }, 50);
    return () => window.clearTimeout(timer);
  }, [loading, targetMessageId, messages.length]);

  return (
    <div className="conversation-result-view">
      <header className="conversation-result-view__header">
        <div className="conversation-result-view__kicker">执行结果</div>
        <h3 className="conversation-result-view__title">{item.title}</h3>
        <p className="conversation-result-view__meta">
          {item.workspaceLabel ? `${item.workspaceLabel} · ` : ''}
          {item.statusLabel}
          {summaryProgress ? ` · ${summaryProgress.completed}/${summaryProgress.total}` : ''}
        </p>
      </header>

      {summaryProgress ? (
        <section className="conversation-result-view__section">
          <div className="conversation-result-view__section-title">进度</div>
          <div className="conversation-result-view__progress" aria-hidden="true">
            <i
              style={{
                width: `${summaryProgress.total > 0 ? Math.round((summaryProgress.completed / summaryProgress.total) * 100) : 0}%`,
              }}
            />
          </div>
          <p className="conversation-result-view__hint">
            {summaryProgress.completed} / {summaryProgress.total} 已完成
            {progress && 'failed' in progress && progress.failed ? ` · ${progress.failed} 失败` : ''}
            {progress && 'blocked' in progress && progress.blocked ? ` · ${progress.blocked} 阻塞` : ''}
          </p>
        </section>
      ) : null}

      {tasks.length > 0 ? (
        <section className="conversation-result-view__section">
          <div className="conversation-result-view__section-title">子任务</div>
          <ul className="conversation-result-view__task-list">
            {tasks.map((task) => (
              <li key={task.taskId} className={`is-${task.status}`}>
                <span className="conversation-result-view__task-status">{statusLabel(task.status)}</span>
                <span className="conversation-result-view__task-title">{task.title}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="conversation-result-view__section conversation-result-view__section--grow">
        <div className="conversation-result-view__section-title">会话内容</div>
        {loading ? (
          <p className="conversation-result-view__hint">加载执行内容…</p>
        ) : error ? (
          <p className="conversation-result-view__error">{error}</p>
        ) : !item.conversationId ? (
          <p className="conversation-result-view__hint">此任务未绑定会话，仅展示计划摘要。</p>
        ) : messages.length === 0 ? (
          <p className="conversation-result-view__hint">会话中暂无消息。</p>
        ) : (
          <div className="conversation-result-view__messages">
            {messages.map((msg) => {
              const isTarget = msg.id === targetMessageId;
              const markdown = messageMarkdown(msg);
              return (
                <article
                  key={msg.id}
                  ref={isTarget ? targetMsgRef : undefined}
                  data-message-id={msg.id}
                  data-task-target={isTarget ? 'true' : undefined}
                  className={`conversation-result-view__msg is-${msg.role}${isTarget ? ' is-task-target' : ''}`}
                >
                  <div className="conversation-result-view__msg-role">
                    {roleLabel(msg.role)}
                    {isTarget ? <span className="conversation-result-view__target-tag">本任务</span> : null}
                  </div>
                  <div className="conversation-result-view__msg-body">
                    {markdown ? (
                      <MarkdownMessage content={markdown} />
                    ) : (
                      <span className="conversation-result-view__hint">（无文本内容）</span>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {canAccept ? (
        <footer className="conversation-result-view__footer">
          <button
            type="button"
            className="task-overview-btn task-overview-btn--primary"
            disabled={accepting}
            onClick={() => {
              setAccepting(true);
              void Promise.resolve(onAcceptResult?.(item)).finally(() => setAccepting(false));
            }}
          >
            {accepting ? '确认中…' : '确认验收'}
          </button>
        </footer>
      ) : null}
    </div>
  );
}

function roleLabel(role: ChatMsg['role']): string {
  if (role === 'assistant') return 'Peer';
  if (role === 'system') return '系统';
  return '你';
}

function statusLabel(status: string): string {
  switch (status) {
    case 'completed':
      return '完成';
    case 'failed':
      return '失败';
    case 'running':
      return '进行中';
    case 'pending':
      return '待开始';
    case 'cancelled':
      return '已取消';
    case 'waiting_user':
      return '待你';
    default:
      return status;
  }
}

function messageMarkdown(msg: ChatMsg): string {
  const raw = (msg.content || '').trim();
  if (raw) return raw;
  if (Array.isArray(msg.segments) && msg.segments.length > 0) {
    const fromSegments = contentFromSegments(msg.segments, '').trim();
    if (fromSegments) return fromSegments;
    const toolHints = msg.segments
      .map((seg) => {
        if (!seg || typeof seg !== 'object') return '';
        if ((seg as { type?: string }).type === 'tool-call') {
          const name =
            (seg as { name?: string; tool?: string }).name ||
            (seg as { tool?: string }).tool ||
            'tool';
          return '**工具调用** `' + name + '`';
        }
        return '';
      })
      .filter(Boolean);
    if (toolHints.length) return toolHints.join('\n\n');
  }
  return '';
}

/**
 * 定位与当前 Task 最相关的消息：
 * 1) 正文/片段含 planId / taskId
 * 2) 用户消息含 plan.title / plan.goal / item.title
 * 3) 取最后一次匹配，否则回退最后一条消息
 */
function findTaskRelatedMessageId(
  messages: readonly ChatMsg[],
  item: TaskOverviewItem,
  plan: GoalPlan | null,
): string | null {
  if (messages.length === 0) return null;

  const needles: string[] = [];
  if (item.taskId) needles.push(item.taskId);
  if (item.title?.trim()) needles.push(item.title.trim());
  if (plan?.planId) needles.push(plan.planId);
  if (plan?.title?.trim()) needles.push(plan.title.trim());
  if (plan?.goal?.trim()) {
    const g = plan.goal.trim();
    needles.push(g.length > 40 ? g.slice(0, 40) : g);
  }

  const uniqueNeedles = [...new Set(needles.filter((n) => n.length >= 2))];
  if (uniqueNeedles.length === 0) {
    return messages[messages.length - 1]?.id ?? null;
  }

  let lastIdMatch: string | null = null;
  let lastTitleMatch: string | null = null;

  for (const msg of messages) {
    const blob = messageSearchBlob(msg);
    if (!blob) continue;
    if (item.taskId && blob.includes(item.taskId)) {
      lastIdMatch = msg.id;
      continue;
    }
    if (plan?.planId && blob.includes(plan.planId)) {
      lastIdMatch = msg.id;
      continue;
    }
    for (const needle of uniqueNeedles) {
      if (needle === item.taskId || needle === plan?.planId) continue;
      if (blob.includes(needle)) {
        if (msg.role === 'user') lastTitleMatch = msg.id;
        else if (!lastTitleMatch) lastTitleMatch = msg.id;
        break;
      }
    }
  }

  return lastIdMatch || lastTitleMatch || messages[messages.length - 1]?.id || null;
}

function messageSearchBlob(msg: ChatMsg): string {
  const parts: string[] = [];
  if (msg.content) parts.push(msg.content);
  if (Array.isArray(msg.segments)) {
    for (const seg of msg.segments) {
      if (!seg || typeof seg !== 'object') continue;
      if ((seg as { type?: string }).type === 'text' && typeof (seg as { content?: string }).content === 'string') {
        parts.push((seg as { content: string }).content);
      }
      if ((seg as { type?: string }).type === 'tool-call') {
        const name = (seg as { name?: string; tool?: string }).name || (seg as { tool?: string }).tool || '';
        const args =
          (seg as { arguments?: unknown; args?: unknown }).arguments ?? (seg as { args?: unknown }).args;
        parts.push(name);
        if (args != null) {
          try {
            parts.push(typeof args === 'string' ? args : JSON.stringify(args));
          } catch {
            // ignore
          }
        }
      }
    }
  }
  return parts.join('\n');
}
