/**
 * TaskOverview IPC 注册 —— Peer 2.0 阶段 1。
 *
 * 通道：
 * - taskOverview:list（invoke）：返回聚合投影 TaskOverviewItem[]。
 * - taskOverview:changed（event，main → renderer）：由 goal-plan-change-bridge /
 *   automations:changed fan-out 触发，renderer 收到后重拉 list。
 *
 * 治理红线：renderer 只消费 taskOverview:list 的投影产物，不自行推断行动权。
 * 聚合逻辑见 task-overview-aggregator.mjs，状态映射见 @peer-agent/protocol
 * task-overview.ts（§11 契约）。
 */

function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function owner(ownerName, register) {
  return Object.freeze({ owner: ownerName, register });
}

/**
 * @param {object} deps
 * @param {{ listTaskOverview: (query?: object) => Array<import('@peer-agent/protocol').TaskOverviewItem> }} deps.taskOverview
 */
export function createTaskOverviewIpcRegistrations({ taskOverview } = {}) {
  const listTaskOverview = assertFunction(
    taskOverview?.listTaskOverview,
    'taskOverview.listTaskOverview',
  );

  return Object.freeze([
    owner('taskOverview-ipc', (ipc) => {
      // payload: { workspacePath?, includeTerminal?, activeWithinMs?, limit? }
      ipc.handle('taskOverview:list', (_event, payload) => listTaskOverview(payload ?? {}));
    }),
  ]);
}
