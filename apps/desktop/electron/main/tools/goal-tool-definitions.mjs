import {
  SHARED_LOCAL_TOOL_CONTRACTS,
  GOAL_CREATE_PLAN_PROMPT,
  GOAL_UPDATE_TASK_PROMPT,
  GOAL_GET_PLAN_PROMPT,
  GOAL_REQUEST_EXPLORER_PROMPT,
  GOAL_CREATE_PLAN_INPUT_SCHEMA,
  GOAL_UPDATE_TASK_INPUT_SCHEMA,
  GOAL_GET_PLAN_INPUT_SCHEMA,
  GOAL_REQUEST_EXPLORER_INPUT_SCHEMA,
} from '@peer-agent/runtime-core';

/**
 * Plan / Goal 目标追踪工具定义（Manifest）—— 见 Plan 模式设计与 Goal 模式设计。
 *
 * 该工具经正规运行时链路暴露：
 *   Capability Provider(local.goal.update_task) → Manifest(本文件) → Runtime Projection
 *     → Tool Call(goal_update_task) → PermissionGrant → Evidence
 *
 * 用途：Plan 模式用这些工具建立审批前的持久计划；Goal 模式用同一套
 * plan/task/evidence 结构做自驱目标追踪。agent 运行时在完成（或失败/受阻）
 * 某个子任务后，显式调用本工具，把刚产生的 evidenceRefs 回写到对应子任务，由
 * goal-plan-store 落盘并自底向上重算进度。"completed 必须带 evidenceRefs" 的治理
 * 约束在 store 层强制。
 */

export const GOAL_TOOL_NAMES = Object.freeze({
  createPlan: SHARED_LOCAL_TOOL_CONTRACTS.goalCreatePlan.toolName,
  updateTask: SHARED_LOCAL_TOOL_CONTRACTS.goalUpdateTask.toolName,
  getPlan: SHARED_LOCAL_TOOL_CONTRACTS.goalGetPlan.toolName,
  requestExplorer: SHARED_LOCAL_TOOL_CONTRACTS.requestExplorer.toolName,
});

// Tool prompts + input schemas are shared with TUI in @peer-agent/runtime-core
// (goal-tool-contracts.ts) so the model-visible contract cannot drift per surface.

export const GOAL_TOOL_DEFINITIONS = [
  {
    name: GOAL_TOOL_NAMES.createPlan,
    capabilityId: SHARED_LOCAL_TOOL_CONTRACTS.goalCreatePlan.capabilityId,
    // 在 plan 与 goal 模式投影给模型（ADR 35）。plan 用于产出/求批准计划,goal 用于自驱规划;
    // mode 隔离在 Runtime Projection 层强制,不依赖系统提示词或执行层闸门兜底。
    // Agent 默认（wire=chat）与 legacy goal 共用自驱规划工具；plan 保留人审路径。
    availableInModes: ['chat', 'plan', 'goal'],
    prompt: () => GOAL_CREATE_PLAN_PROMPT,
    runtime: Object.freeze({
      adapter: 'runtime-gateway.local-goal-provider',
      executorCapabilityId: SHARED_LOCAL_TOOL_CONTRACTS.goalCreatePlan.capabilityId,
    }),
    permissionPolicy: {
      kind: 'goal-create',
    },
    inputSchema: GOAL_CREATE_PLAN_INPUT_SCHEMA,
  },
  {
    name: GOAL_TOOL_NAMES.updateTask,
    capabilityId: SHARED_LOCAL_TOOL_CONTRACTS.goalUpdateTask.capabilityId,
    // 在 plan 与 goal 模式投影给模型（ADR 35）。
    // Agent 默认（wire=chat）与 legacy goal 共用自驱规划工具；plan 保留人审路径。
    availableInModes: ['chat', 'plan', 'goal'],
    prompt: () => GOAL_UPDATE_TASK_PROMPT,
    runtime: Object.freeze({
      adapter: 'runtime-gateway.local-goal-provider',
      executorCapabilityId: SHARED_LOCAL_TOOL_CONTRACTS.goalUpdateTask.capabilityId,
    }),
    permissionPolicy: {
      kind: 'goal-update',
    },
    inputSchema: GOAL_UPDATE_TASK_INPUT_SCHEMA,
  },
  {
    name: GOAL_TOOL_NAMES.getPlan,
    capabilityId: SHARED_LOCAL_TOOL_CONTRACTS.goalGetPlan.capabilityId,
    // 在 plan 与 goal 模式投影给模型（ADR 35）。
    // Agent 默认（wire=chat）与 legacy goal 共用自驱规划工具；plan 保留人审路径。
    availableInModes: ['chat', 'plan', 'goal'],
    prompt: () => GOAL_GET_PLAN_PROMPT,
    runtime: Object.freeze({
      adapter: 'runtime-gateway.local-goal-provider',
      executorCapabilityId: SHARED_LOCAL_TOOL_CONTRACTS.goalGetPlan.capabilityId,
    }),
    permissionPolicy: {
      kind: 'goal-read',
    },
    inputSchema: GOAL_GET_PLAN_INPUT_SCHEMA,
  },
  {
    name: GOAL_TOOL_NAMES.requestExplorer,
    capabilityId: SHARED_LOCAL_TOOL_CONTRACTS.requestExplorer.capabilityId,
    // 仅在 goal 模式投影给模型（ADR 35）。Explorer 是 Runner 编排的只读子 Agent，
    // 登记式：本工具仅把请求记入回合，由 Goal Runner 在回合结束后派发执行。
    // request_explorer：Agent（chat）与 legacy goal 自驱编排可用。
    availableInModes: ['chat', 'goal'],
    prompt: () => GOAL_REQUEST_EXPLORER_PROMPT,
    runtime: Object.freeze({
      adapter: 'runtime-gateway.local-goal-provider',
      executorCapabilityId: SHARED_LOCAL_TOOL_CONTRACTS.requestExplorer.capabilityId,
    }),
    permissionPolicy: {
      kind: 'goal-explore',
    },
    inputSchema: GOAL_REQUEST_EXPLORER_INPUT_SCHEMA,
  },
];
