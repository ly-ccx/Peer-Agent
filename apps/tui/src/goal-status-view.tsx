import { COLOR } from './tui-theme.ts';
import { goalTaskGlyph, type GoalStatusViewModel } from './goal-status-model.ts';

function statusColor(status: string): string {
  if (status === 'completed') return COLOR.success;
  if (status === 'failed' || status === 'blocked' || status === 'waiting_user') return COLOR.danger;
  if (status === 'running' || status === 'executing') return COLOR.diffHunk;
  return COLOR.muted;
}

export function GoalStatusPanel({ view, width }: {
  readonly view: GoalStatusViewModel;
  readonly width: number;
}) {
  return (
    <box
      width={width}
      height="100%"
      flexShrink={0}
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={COLOR.border}
      backgroundColor={COLOR.panel}
      padding={1}
      gap={1}
    >
      <text fg={COLOR.accent}><strong>GOAL</strong></text>
      <text fg={COLOR.text} wrapMode="word"><strong>{view.title}</strong></text>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={statusColor(view.status)}>{view.status}</text>
        <text fg={COLOR.muted}>{view.completed}/{view.total} · {view.percent}%</text>
      </box>
      {view.currentTask ? (
        <box flexDirection="column">
          <text fg={COLOR.muted}>CURRENT</text>
          <text fg={statusColor(view.currentTask.status)} wrapMode="word">
            {goalTaskGlyph(view.currentTask.status)} {view.currentTask.title}
          </text>
        </box>
      ) : null}
      <box flexDirection="column" flexGrow={1} overflow="hidden">
        <text fg={COLOR.muted}>TASKS</text>
        {view.tasks.slice(0, 10).map((task) => (
          <text key={task.id} fg={statusColor(task.status)} wrapMode="word">
            {goalTaskGlyph(task.status)} {task.title}
          </text>
        ))}
        {view.tasks.length > 10 ? <text fg={COLOR.muted}>+{view.tasks.length - 10} more</text> : null}
      </box>
      {view.blockedReason ? (
        <box flexDirection="column" border borderStyle="rounded" borderColor={COLOR.danger} padding={1}>
          <text fg={COLOR.danger}><strong>NEEDS ATTENTION</strong></text>
          <text fg={COLOR.text} wrapMode="word">{view.blockedReason}</text>
        </box>
      ) : null}
    </box>
  );
}

export function GoalCompactSummary({ view }: { readonly view: GoalStatusViewModel }) {
  const current = view.currentTask ? ` · ${goalTaskGlyph(view.currentTask.status)} ${view.currentTask.title}` : '';
  return (
    <text fg={statusColor(view.status)} wrapMode="none">
      Goal {view.completed}/{view.total} · {view.status}{current}
    </text>
  );
}
