/**
 * Goal 模式本地工具定义（Manifest）—— 见 docs/proposals/0002-goal-mode.md。
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
  updateTask: 'goal_update_task',
});

const GOAL_TOOL_PROMPT = [
  'Record execution evidence for a goal-plan subtask (goal mode only).',
  'Call this after you finish, fail, or get blocked on a subtask during the execute phase',
  'of an approved goal plan. Mark a subtask "completed" only when you can supply the',
  'evidenceRefs (artifact refs / tool-result refs) that prove it is done — the store',
  'rejects a "completed" status without evidenceRefs. Progress is recomputed bottom-up',
  'from leaf subtasks; do not hand-maintain progress.',
].join(' ');

export const GOAL_TOOL_DEFINITIONS = [
  {
    name: GOAL_TOOL_NAMES.updateTask,
    capabilityId: 'local.goal.update',
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
];
