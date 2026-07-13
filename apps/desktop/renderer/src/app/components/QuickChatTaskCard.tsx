import { useEffect, useState } from 'react';
import type { QuickChatTask } from '../../chat/state/quickChatTasks';

export function QuickChatTaskCard({
  task,
  position,
  total,
  submitting,
  onPrevious,
  onNext,
  onSelect,
  onPlanAction,
  onOpenConversation,
}: {
  readonly task: QuickChatTask;
  readonly position: number;
  readonly total: number;
  readonly submitting: boolean;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
  readonly onSelect: (option: string) => void;
  readonly onPlanAction: (action: 'start' | 'adjust' | 'cancel') => void;
  readonly onOpenConversation: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const taskKey = task.kind === 'plan-approval' ? task.plan.planId : task.assistantMessageId;
  useEffect(() => setSelected(null), [taskKey]);

  return (
    <aside className="quick-chat-task-card" aria-label="待处理任务">
      <header className="quick-chat-task-header">
        <div className="quick-chat-task-title">
          <span className="quick-chat-task-dot" aria-hidden="true" />
          <span>{task.kind === 'plan-approval' ? '计划待确认' : '需要你选择'}</span>
          <span className="quick-chat-task-conversation">{task.conversationTitle}</span>
        </div>
        {total > 1 ? (
          <div className="quick-chat-task-pager" aria-label={`第 ${position + 1} 个，共 ${total} 个任务`}>
            <button type="button" onClick={onPrevious} aria-label="上一个任务">‹</button>
            <span>{position + 1}/{total}</span>
            <button type="button" onClick={onNext} aria-label="下一个任务">›</button>
          </div>
        ) : null}
      </header>
      {task.kind === 'plan-approval' ? (
        <>
          <p className="quick-chat-task-question">{task.plan.title}</p>
          <p className="quick-chat-task-hint">{task.plan.goal}</p>
          <ol className="quick-chat-plan-steps">
            {task.plan.tasks.slice(0, 3).map((item) => <li key={item.taskId}>{item.title}</li>)}
          </ol>
          <div className="quick-chat-task-options">
            <button type="button" disabled={submitting} onClick={() => onPlanAction('start')}>开始执行</button>
            <button type="button" disabled={submitting} onClick={() => onPlanAction('adjust')}>调整计划</button>
            <button type="button" disabled={submitting} onClick={() => onPlanAction('cancel')}>取消计划</button>
          </div>
        </>
      ) : (
        <>
          <p className="quick-chat-task-question">{task.view.question}</p>
          {task.view.options.length ? (
            <div className="quick-chat-task-options">
              {task.view.options.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={selected === option ? 'selected' : ''}
                  disabled={submitting || selected !== null}
                  onClick={() => { setSelected(option); onSelect(option); }}
                >
                  {selected === option ? '✓ ' : ''}{option}
                </button>
              ))}
            </div>
          ) : <p className="quick-chat-task-hint">请打开对应会话继续处理。</p>}
        </>
      )}
      <footer className="quick-chat-task-footer">
        <span>{submitting || selected ? '正在提交…' : task.kind === 'plan-approval' ? '确认后将按计划继续' : '选择后将直接回复该会话'}</span>
        <button type="button" disabled={submitting} onClick={onOpenConversation}>打开会话</button>
      </footer>
    </aside>
  );
}
