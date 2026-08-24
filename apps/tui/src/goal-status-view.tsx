import { COLOR } from './tui-theme.ts';
import {
  goalCompactSummaryView,
  goalStatusFromSharedPlan,
  goalStatusTone,
  goalTaskGlyph,
  type GoalStatusTone,
  type GoalStatusViewModel,
} from './goal-status-model.ts';
import type { TuiGoalPlan } from './goal-plan-history.ts';
import { selectionWindow } from './tui-experience.ts';

function toneColor(tone: GoalStatusTone): string {
  if (tone === 'success') return COLOR.success;
  if (tone === 'danger') return COLOR.danger;
  if (tone === 'accent') return COLOR.accent;
  return COLOR.muted;
}

function statusColor(status: string): string {
  return toneColor(goalStatusTone(status));
}

export function GoalStatusPanel({
  view,
  width,
  missionPosition = 1,
  totalPlans = 1,
  onOpenHistory,
}: {
  readonly view: GoalStatusViewModel;
  readonly width: number;
  readonly missionPosition?: number;
  readonly totalPlans?: number;
  readonly onOpenHistory?: () => void;
}) {
  const progressWidth = Math.max(8, width - 6);
  const progressDone = Math.round(progressWidth * view.percent / 100);
  const progressTrack = `${'━'.repeat(progressDone)}${'─'.repeat(progressWidth - progressDone)}`;
  const missionOrdinal = String(missionPosition).padStart(2, '0');

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
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      gap={1}
    >
      <box flexDirection="row" justifyContent="space-between">
        <text fg={COLOR.accent} onMouseDown={totalPlans > 1 ? onOpenHistory : undefined}>
          <strong>MISSION / {missionOrdinal} OF {totalPlans}</strong>
        </text>
        <text fg={statusColor(view.status)}>● {view.status.toUpperCase()}</text>
      </box>
      {totalPlans > 1 ? (
        <text fg={COLOR.muted} wrapMode="none" onMouseDown={onOpenHistory}>
          {totalPlans} GOALS · /goals switch
        </text>
      ) : null}
      <text fg={COLOR.text} wrapMode="word"><strong>{view.title}</strong></text>
      <box flexDirection="column">
        <box flexDirection="row" justifyContent="space-between">
          <text fg={COLOR.muted}>{view.completed} / {view.total} COMPLETE</text>
          <text fg={COLOR.muted}>{view.percent}%</text>
        </box>
        <text fg={COLOR.accent} wrapMode="none">{progressTrack}</text>
      </box>
      {view.currentTask ? (
        <box flexDirection="column">
          <text fg={COLOR.muted}>NOW WORKING</text>
          <box flexDirection="column" border={['left']} borderColor={COLOR.accent} paddingLeft={1}>
            <text fg={COLOR.accent}>◇ ACTIVE</text>
            <text fg={COLOR.text} wrapMode="word">{view.currentTask.title}</text>
          </box>
        </box>
      ) : null}
      <box flexDirection="column" flexGrow={1} overflow="hidden">
        <text fg={COLOR.muted}>TASKS</text>
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

export function GoalCompactSummary({
  view,
  missionPosition = 1,
  totalPlans = 1,
  onOpenHistory,
}: {
  readonly view: GoalStatusViewModel;
  readonly missionPosition?: number;
  readonly totalPlans?: number;
  readonly onOpenHistory?: () => void;
}) {
  const compact = goalCompactSummaryView(view, { missionPosition, totalPlans });
  return (
    <box
      flexDirection="row"
      width="100%"
      flexShrink={0}
      justifyContent="space-between"
      onMouseDown={totalPlans > 1 ? onOpenHistory : undefined}
    >
      <box flexDirection="row" flexGrow={1} minWidth={0}>
        <text fg={toneColor(compact.tone)} wrapMode="none">{compact.glyph}</text>
        <text fg={COLOR.text} wrapMode="none" flexGrow={1} minWidth={0}> {compact.title}</text>
      </box>
      <box flexDirection="row" flexShrink={0}>
        {compact.missionLabel ? (
          <text fg={COLOR.subtle} wrapMode="none">{compact.missionLabel}  </text>
        ) : null}
        <text fg={COLOR.muted} wrapMode="none">{compact.progressTrack}</text>
        <text fg={COLOR.subtle} wrapMode="none">  {compact.progressCount}</text>
      </box>
    </box>
  );
}

export function GoalPlanPicker({
  plans,
  selectedIndex,
  currentPlanId,
  query,
  maxVisible,
  outerPadding,
  onSelect,
}: {
  readonly plans: readonly TuiGoalPlan[];
  readonly selectedIndex: number;
  readonly currentPlanId: string | null;
  readonly query: string;
  readonly maxVisible: number;
  readonly outerPadding: number;
  readonly onSelect: (planId: string) => void;
}) {
  const visiblePlans = selectionWindow(plans, selectedIndex, maxVisible);
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      border={['top']}
      borderColor={COLOR.border}
      backgroundColor={COLOR.background}
      paddingLeft={outerPadding}
      paddingRight={outerPadding}
      paddingTop={1}
      paddingBottom={1}
    >
      <text fg={COLOR.accent} wrapMode="none"><strong>Goal history</strong> · {plans.length} formal goals</text>
      <text fg={COLOR.muted} wrapMode="none">Search: {query || '…'}</text>
      {visiblePlans.length === 0 ? (
        <text fg={COLOR.muted}>No matching formal goals.</text>
      ) : visiblePlans.map(({ item: plan, index }) => {
        const selected = index === selectedIndex;
        const view = goalStatusFromSharedPlan(plan);
        const current = plan.planId === currentPlanId;
        return (
          <box
            key={plan.planId}
            flexDirection="row"
            height={1}
            justifyContent="space-between"
            onMouseDown={() => onSelect(plan.planId)}
          >
            <text fg={selected ? COLOR.accent : COLOR.textSoft} wrapMode="none" flexGrow={1} minWidth={0}>
              {selected ? '› ' : '  '}{index + 1}. {view?.title ?? 'Goal'}{current ? ' ✓' : ''}
            </text>
            <text fg={statusColor(view?.status ?? 'unknown')} wrapMode="none" flexShrink={0} marginLeft={2}>
              {view?.status ?? 'unknown'} · {view?.completed ?? 0}/{view?.total ?? 0}
            </text>
          </box>
        );
      })}
      <text fg={COLOR.muted} wrapMode="none">type search · ↑↓ choose · enter view · esc close</text>
    </box>
  );
}
