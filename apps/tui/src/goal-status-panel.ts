/**
 * Stable Goal status-panel interface.
 *
 * Wide terminals use a side-by-side main interaction area and right Goal status area.
 * Narrow terminals consume the same view model as a compact summary.
 */
export {
  goalCompactSummaryView,
  goalProgressTrack,
  goalStatusFromRuntime,
  goalStatusFromSharedPlan,
  goalStatusLayout,
  goalStatusTone,
  goalTaskGlyph,
  type GoalCompactSummaryView,
  type GoalStatusLayoutMode,
  type GoalStatusTaskView,
  type GoalStatusTone,
  type GoalStatusViewModel,
} from './goal-status-model.ts';
