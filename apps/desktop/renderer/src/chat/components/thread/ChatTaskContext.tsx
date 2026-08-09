import type { ChatTaskContextView } from './taskContext';

export function ChatTaskContext({
  context,
  onOpenDetails,
}: {
  readonly context: ChatTaskContextView;
  readonly onOpenDetails?: () => void;
}) {
  return (
    <button
      type="button"
      className="chat-task-context"
      onClick={onOpenDetails}
      disabled={!onOpenDetails}
      aria-label={context.detailLabel}
      title={context.detailLabel}
    >
      <span className="chat-task-context__status">{context.statusLabel}</span>
      {context.currentGoalTitle ? (
        <span className="chat-task-context__goal">{context.currentGoalTitle}</span>
      ) : null}
      <span className="chat-task-context__details">{context.detailLabel}</span>
    </button>
  );
}
