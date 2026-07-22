/**
 * Stable Goal status-panel interface.
 *
 * Wide terminals use a side-by-side main interaction area and right Goal status area.
 * Narrow terminals consume the same view model as a compact summary.
 */
export {
  goalStatusFromRuntime,
  goalStatusFromSharedPlan,
  goalStatusLayout,
  goalTaskGlyph,
  type GoalStatusLayoutMode,
  type GoalStatusTaskView,
  type GoalStatusViewModel,
} from './goal-status-model.ts';
