/**
 * Goal 模式本地工具定义（Manifest）—— 见 Goal 模式设计。
 *
 * 该工具经正规运行时链路暴露：
 *   Capability Provider(local.goal.update) → Manifest(本文件) → Runtime Projection
 *     → Tool Call(goal_update_task) → PermissionGrant → Evidence
 *
 * 用途：goal 模式"先规划 → 批准 → 执行"阶段，agent 运行时在完成（或失败/受阻）
 * 某个子任务后，显式调用本工具，把刚产生的 evidenceRefs 回写到对应子任务，由
 * goal-plan-store 落盘并自底向上重算进度。"completed 必须带 evidenceRefs" 的治理
 * 约束在 store 层强制。
 */

export const GOAL_TOOL_NAMES = Object.freeze({
  createPlan: 'goal_create_plan',
  updateTask: 'goal_update_task',
  getPlan: 'goal_get_plan',
});

const GOAL_CREATE_PLAN_PROMPT = [
  'Create a persistent, trackable goal plan (goal mode only). Call this FIRST in goal mode,',
  'before doing any side-effecting work: in goal mode the runtime blocks side-effecting tools',
  'until a plan exists and the user approves it. Provide a clear goal and a complete list of',
  'ordered subtasks (each subtask: title, optional dependsOn). The plan is saved as a draft',
  'awaiting approval; after creating it, ask the user to approve via request_user_input.',
  'Do not start executing subtasks until the user approves.',
].join(' ');

const GOAL_TOOL_PROMPT = [
  'Record execution evidence for a goal-plan subtask (goal mode only).',
  'Call this after you finish, fail, or get blocked on a subtask during the execute phase',
  'of an approved goal plan. Mark a subtask "completed" only when you can supply the',
  'evidenceRefs (artifact refs / tool-result refs) that prove it is done — the store',
  'rejects a "completed" status without evidenceRefs. Progress is recomputed bottom-up',
  'from leaf subtasks; do not hand-maintain progress.',
].join(' ');

const GOAL_GET_PLAN_PROMPT = [
  'Read back an existing goal plan (goal mode only). Read-only and side-effect free.',
  'Use this to recover the authoritative subtask taskId list and current statuses —',
  'for example after a long conversation or context compaction when you are unsure of',
  'the exact taskId to pass to goal_update_task. Pass planId to fetch one plan; omit',
  'planId to list the active plans for the current conversation. Always trust the',
  'taskId values returned here over any taskId you remember.',
].join(' ');

export const GOAL_TOOL_DEFINITIONS = [
  {
    name: GOAL_TOOL_NAMES.createPlan,
    capabilityId: 'local.goal.create',
    // 仅在 goal 模式投影给模型（ADR 35）。mode 隔离在 Runtime Projection 层强制，
    // 不依赖系统提示词或执行层闸门兜底。
    availableInModes: ['goal'],
    prompt: () => GOAL_CREATE_PLAN_PROMPT,
    runtime: Object.freeze({
      adapter: 'runtime-gateway.local-goal-provider',
      executorCapabilityId: 'local.goal.create',
    }),
    permissionPolicy: {
      kind: 'goal-create',
    },
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Short title for the plan.',
        },
        goal: {
          type: 'string',
          description: 'The concrete goal this plan aims to achieve, in one or two sentences.',
        },
        tasks: {
          type: 'array',
          description: 'Ordered list of subtasks that make up the plan.',
          items: {
            type: 'object',
            properties: {
              taskId: {
                type: 'string',
                description: 'Optional stable id for the subtask; generated if omitted.',
              },
              title: {
                type: 'string',
                description: 'What this subtask delivers.',
              },
              dependsOn: {
                type: 'array',
                items: { type: 'string' },
                description: 'taskIds this subtask depends on (must run after them).',
              },
            },
            required: ['title'],
            additionalProperties: false,
          },
        },
      },
      required: ['goal', 'tasks'],
      additionalProperties: false,
    },
  },
  {
    name: GOAL_TOOL_NAMES.updateTask,
    capabilityId: 'local.goal.update',
    // 仅在 goal 模式投影给模型（ADR 35）。
    availableInModes: ['goal'],
    prompt: () => GOAL_TOOL_PROMPT,
    runtime: Object.freeze({
      adapter: 'runtime-gateway.local-goal-provider',
      executorCapabilityId: 'local.goal.update',
    }),
    permissionPolicy: {
      kind: 'goal-update',
    },
    inputSchema: {
      type: 'object',
      properties: {
        planId: {
          type: 'string',
          description: 'Target goal plan id (planId).',
        },
        taskId: {
          type: 'string',
          description: 'Target subtask id (taskId) within the plan. Must reference a leaf subtask when setting completion.',
        },
        status: {
          type: 'string',
          enum: ['pending', 'running', 'completed', 'failed', 'cancelled', 'waiting_user'],
          description: 'New execution status for the subtask. Use "completed" only with evidenceRefs.',
        },
        evidenceRefs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Artifact refs / tool-result refs that prove the subtask outcome. Required to mark completed.',
        },
        result: {
          type: 'string',
          description: 'Short factual summary of what was produced (optional).',
        },
        failureReason: {
          type: 'string',
          description: 'Why the subtask failed (when status=failed).',
        },
        blockedReason: {
          type: 'string',
          description: 'Why the subtask is blocked / waiting (when status=waiting_user).',
        },
      },
      required: ['planId', 'taskId'],
      additionalProperties: false,
    },
  },
  {
    name: GOAL_TOOL_NAMES.getPlan,
    capabilityId: 'local.goal.read',
    // 仅在 goal 模式投影给模型（ADR 35）。
    availableInModes: ['goal'],
    prompt: () => GOAL_GET_PLAN_PROMPT,
    runtime: Object.freeze({
      adapter: 'runtime-gateway.local-goal-provider',
      executorCapabilityId: 'local.goal.read',
    }),
    permissionPolicy: {
      kind: 'goal-read',
    },
    inputSchema: {
      type: 'object',
      properties: {
        planId: {
          type: 'string',
          description:
            'Target goal plan id (planId) to read back. Omit to list the active plans for the current conversation.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
];
