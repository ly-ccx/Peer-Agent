/**
 * 右侧工作台拖拽的渐进阶段。
 *
 * 比例按窗口宽度计算：
 * - 到达 60% 且左栏开着时，自动收起左栏；
 * - 到达 80% 时进入全屏；
 * - 反向拖回带滞回，避免在阈值附近横跳。
 *
 * 拖拽上限是窗口宽度本身，不再用 0.55 / 900px 卡住。
 */

export const WORKBENCH_SIDEBAR_COLLAPSE_RATIO = 0.6;
/** 低于该比例才把自动收起的左栏展开回来。 */
export const WORKBENCH_SIDEBAR_RESTORE_RATIO = 0.55;
export const WORKBENCH_MAXIMIZE_RATIO = 0.8;
/** 低于该比例才退出拖拽进入的全屏。 */
export const WORKBENCH_MAXIMIZE_RESTORE_RATIO = 0.75;

export interface WorkbenchResizeStageInput {
  readonly viewportWidth: number;
  readonly workbenchWidth: number;
  readonly sidebarOpen: boolean;
  readonly sidebarAutoCollapsed: boolean;
  readonly maximized: boolean;
}

export interface WorkbenchResizeStage {
  readonly ratio: number;
  readonly sidebarAutoCollapsed: boolean;
  readonly maximized: boolean;
}

export function workbenchWidthRatio(workbenchWidth: number, viewportWidth: number): number {
  if (viewportWidth <= 0) return 0;
  return workbenchWidth / viewportWidth;
}

export function clampWorkbenchWidth(value: number, viewportWidth: number, minWidth: number): number {
  const upper = Math.max(minWidth, Math.max(0, Math.floor(viewportWidth)));
  return Math.min(upper, Math.max(minWidth, Math.round(value)));
}

export function resolveWorkbenchResizeStage(input: WorkbenchResizeStageInput): WorkbenchResizeStage {
  const ratio = workbenchWidthRatio(input.workbenchWidth, input.viewportWidth);
  let sidebarAutoCollapsed = input.sidebarAutoCollapsed;
  if (input.sidebarOpen) {
    if (!sidebarAutoCollapsed && ratio >= WORKBENCH_SIDEBAR_COLLAPSE_RATIO) {
      sidebarAutoCollapsed = true;
    } else if (sidebarAutoCollapsed && ratio <= WORKBENCH_SIDEBAR_RESTORE_RATIO) {
      sidebarAutoCollapsed = false;
    }
  }

  let maximized = input.maximized;
  if (!maximized && ratio >= WORKBENCH_MAXIMIZE_RATIO) {
    maximized = true;
  } else if (maximized && ratio <= WORKBENCH_MAXIMIZE_RESTORE_RATIO) {
    maximized = false;
  }

  return { ratio, sidebarAutoCollapsed, maximized };
}
