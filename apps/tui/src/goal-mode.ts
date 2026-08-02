/**
 * @deprecated TUI 的产品级 Goal 执行统一由 `createTuiSharedGoalRunner` 驱动。
 *
 * 保留此入口只为兼容旧导入；它必须始终指向共享 GoalPlan pump 的 TUI adapter，
 * 不得在 TUI 内重新包装低层 Runtime Goal controller 或维护第二套状态机。
 */
export {
  createTuiSharedGoalRunner as createTuiGoalRunner,
  type TuiSharedGoalRunner as TuiGoalRunner,
} from './goal-runner-adapter.ts';
