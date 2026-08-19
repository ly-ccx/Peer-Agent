import { useEffect, useMemo, useState } from 'react';
import type { GoalPlan, TaskOverviewItem } from '@peer-agent/protocol';
import { clientApi } from '../../clientApi';
import { ChatTurn } from '../../chat/components/thread/ChatTurn';
import { ImagePreviewOverlay } from '../../chat/components/thread/AttachmentStrip';
import { groupMessagesIntoTurns } from '../../chat/state/chatTurns';
import { loadConversationMessages } from '../../chat/state/conversationLoad';
import { findTaskRelatedMessageId } from '../../chat/state/taskRelatedMessage';
import type { ChatAttachment, ChatMsg } from '../../chat/state/types';

/**
 * 工作台「查看结果」用的只读会话/执行内容展示。
 *
 * - 消息：复用主聊天 ChatTurn / AssistantContent，不再压成另一套 Markdown
 * - 相关消息：用 is-task-target 高亮，打开时不自动滚动定位（避免侧栏整体上滚）
 * - 操作区（确认验收）已移至 Drawer footer，本组件只渲染结果内容
 */
export function ConversationResultView({
  item,
  isZh = true,
}: {
  readonly item: TaskOverviewItem;
  readonly isZh?: boolean;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<readonly ChatMsg[]>([]);
  const [plan, setPlan] = useState<GoalPlan | null>(null);
  const [imagePreview, setImagePreview] = useState<ChatAttachment | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setMessages([]);
    setPlan(null);
    setImagePreview(null);

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

  const targetMessageId = useMemo(
    () => findTaskRelatedMessageId(messages, item, plan),
    [messages, item, plan],
  );
  const turns = useMemo(() => groupMessagesIntoTurns(messages), [messages]);

  // 打开结果侧栏时不要自动滚动定位目标消息：会带动 drawer body 祖先滚动，造成「打开就往上滚一下」。
  // 相关消息仍通过 is-task-target 高亮；用户可自行滚动查看。

  return (
    <div className="conversation-result-view">
      <header className="conversation-result-view__header">
        <div className="conversation-result-view__kicker">执行结果</div>
        <h3 className="conversation-result-view__title">{item.title}</h3>
        <p className="conversation-result-view__meta">
          {item.deliveryRoute ? `${item.deliveryRoute} · ` : item.workspaceLabel ? `${item.workspaceLabel} · ` : ''}
          {item.deliveryHandoffLabel ? `${item.deliveryHandoffLabel} · ` : ''}
          {item.statusLabel}
          {summaryProgress ? ` · ${summaryProgress.completed}/${summaryProgress.total}` : ''}
        </p>
      </header>
      {item.qualityChecks && item.qualityChecks.length > 0 ? (
        <section className="conversation-result-view__section">
          <div className="conversation-result-view__section-title">{isZh ? '交卷前查过' : 'Checked before handoff'}</div>
          <ul className="conversation-result-view__checks">
            {item.qualityChecks.map((check) => (
              <li key={check.id} className="conversation-result-view__check">
                <span>{check.label}</span>
                <b>{check.note || (check.status === 'passed' ? (isZh ? '已通过' : 'Passed') : check.status === 'skipped' ? (isZh ? '未做' : 'Skipped') : (isZh ? '未通过' : 'Failed'))}</b>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

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
            {turns.map((turn, turnIndex) => (
              <ChatTurn
                key={turn.id}
                conversationId={item.conversationId ? String(item.conversationId) : null}
                turn={turn}
                isLive={false}
                streamStartedAt={null}
                isZh={isZh}
                turnIndex={turnIndex}
                readOnly
                highlightedMessageId={targetMessageId}
                onPreviewImage={setImagePreview}
              />
            ))}
          </div>
        )}
      </section>
      {imagePreview?.kind === 'image' && imagePreview.dataUrl ? (
        <ImagePreviewOverlay attachment={imagePreview} isZh={isZh} onClose={() => setImagePreview(null)} />
      ) : null}
    </div>
  );
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
