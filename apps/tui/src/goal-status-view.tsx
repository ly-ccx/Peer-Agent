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
  const progressWidth = Math.max(8, width - 6);
  const progressDone = Math.round(progressWidth * view.percent / 100);
  const progressTrack = `${'━'.repeat(progressDone)}${'─'.repeat(progressWidth - progressDone)}`;

  return (
    <box
      width={width}
      height="100%"
      flexShrink={0}
      flexDirection="column"
      border={['left']}
      borderColor={COLOR.border}
      backgroundColor={COLOR.background}
      paddingLeft={2}
      paddingRight={1}
      gap={1}
    >
      <box flexDirection="row" justifyContent="space-between">
        <text fg={COLOR.accent}><strong>MISSION</strong></text>
        <text fg={statusColor(view.status)}>{view.status.toUpperCase()}</text>
      </box>
      <text fg={COLOR.text} wrapMode="word"><strong>{view.title}</strong></text>
      <box flexDirection="column">
        <text fg={COLOR.accent} wrapMode="none">{progressTrack}</text>
        <text fg={COLOR.muted}>{view.completed} of {view.total} complete · {view.percent}%</text>
      </box>
      {view.currentTask ? (
        <box flexDirection="column" border={['left']} borderColor={COLOR.accent} paddingLeft={1}>
          <text fg={COLOR.muted}>NOW WORKING</text>
          <text fg={COLOR.text} wrapMode="word">
            {goalTaskGlyph(view.currentTask.status)} {view.currentTask.title}
          </text>
        </box>
      ) : null}
      <box flexDirection="column" flexGrow={1} overflow="hidden">
        <text fg={COLOR.muted}>QUEUE</text>
        {view.tasks.slice(0, 10).map((task) => (
          <text key={task.id} fg={task.status === 'running' ? COLOR.text : statusColor(task.status)} wrapMode="word">
            {goalTaskGlyph(task.status)}  {task.title}
          </text>
        ))}
        {view.tasks.length > 10 ? <text fg={COLOR.muted}>+{view.tasks.length - 10} more</text> : null}
      </box>
      {view.blockedReason ? (
        <box flexDirection="column" border={['left']} borderColor={COLOR.danger} paddingLeft={1}>
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
