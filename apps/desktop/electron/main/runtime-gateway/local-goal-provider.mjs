import { createGoalPlanStore } from '../goal-plan-store.mjs';
import { createPermissionGrant, nowIso } from './tool-result-factory.mjs';

/**
 * 本地 Goal 能力 Provider —— 见 docs/proposals/0002-goal-mode.md（运行时自动回写）。
 *
 * 设计要点（与 AGENTS.md 非协商运行时链一致）：
 * - goal 模式"先规划 → 批准 → 执行"时，agent 运行时在完成某子任务后，
 *   显式调用 `goal_update_task` 工具，把刚产生的 evidenceRefs 回写到对应子任务。
 * - 回写经正规链路：Capability Provider → Manifest → Runtime Projection → Tool Call
 *   → PermissionGrant → Evidence；不在中央工具链路里嗅探"当前活跃子任务"（那会污染
 *   host 且没有可靠的事实来源）。
 * - store 为纯磁盘型（无内存状态），provider 内用默认路径即可与主进程实例指向同一目录。
 * - "completed 必须带 evidenceRefs" 的治理约束由 store 强制；provider 仅转译失败为工具结果。
 */

const GOAL_CAPABILITY_ID = 'local.goal.update';
const GOAL_CREATE_CAPABILITY_ID = 'local.goal.create';

function parseArgs(call) {
  const raw = call?.arguments;
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return {};
}

/** 把模型给的精简子任务规范化为完整 GoalTask（补齐协议必填字段）。 */
function normalizeTasks(rawTasks) {
  const list = Array.isArray(rawTasks) ? rawTasks : [];
  return list.map((task, index) => ({
    taskId: typeof task?.taskId === 'string' && task.taskId ? task.taskId : `task-${index + 1}`,
    order: index,
    title: typeof task?.title === 'string' ? task.title : '',
    path: [],
    dependsOn: Array.isArray(task?.dependsOn) ? task.dependsOn.filter((d) => typeof d === 'string') : [],
    acceptanceCriteria: [],
    involvedFiles: [],
    status: 'pending',
    evidenceRefs: [],
  }));
}

export function createLocalGoalProvider({ goalPlanStore = createGoalPlanStore() } = {}) {
  async function executeCreatePlan(request, context = {}) {
    const call = request.call;
    const locale = context.locale ?? 'zh-CN';
    const args = parseArgs(call);
    const conversationId = context.toolContext?.conversationId ?? null;

    let status = 'success';
    let payload;

    if (!args.goal || !Array.isArray(args.tasks) || args.tasks.length === 0) {
      status = 'failed';
      payload = {
        ok: false,
        error: locale === 'zh-CN'
          ? 'goal_create_plan 需要提供 goal 以及至少一个子任务（tasks）。'
          : 'goal_create_plan requires a goal and at least one subtask (tasks).',
      };
    } else {
      try {
        const plan = goalPlanStore.createPlan({
          conversationId,
          title: typeof args.title === 'string' ? args.title : '',
          goal: args.goal,
          tasks: normalizeTasks(args.tasks),
          status: 'awaiting_approval',
          createdBy: 'agent',
        });
        payload = {
          ok: true,
          planId: plan.planId,
          status: plan.status,
          taskCount: plan.tasks?.length ?? 0,
          progress: plan.progress ?? null,
          note: locale === 'zh-CN'
            ? '计划已创建并等待用户批准。请用 request_user_input 征求批准后再执行。'
            : 'Plan created and awaiting approval. Ask the user to approve via request_user_input before executing.',
        };
      } catch (err) {
        status = 'failed';
        payload = { ok: false, error: err?.message ? String(err.message) : String(err) };
      }
    }

    const output = JSON.stringify(payload);
    return {
      call,
      grant: createPermissionGrant({
        toolCallId: call.toolCallId,
        granted: status === 'success',
        scope: GOAL_CREATE_CAPABILITY_ID,
      }),
      result: {
        toolCallId: call.toolCallId,
        status,
        outputPreview: {
          status,
          tool: 'goal_create_plan',
          legacyResult: { success: status === 'success', output },
        },
        evidence: {
          evidenceId: `goal-create-${call.toolCallId}`,
          toolCallId: call.toolCallId,
          summary: locale === 'zh-CN'
            ? `Goal 计划创建：planId=${payload.planId ?? '?'} 状态=${payload.status ?? status}。`
            : `Goal plan created: planId=${payload.planId ?? '?'} status=${payload.status ?? status}.`,
          locale,
          returnedToCloud: false,
          dataLevel: 'D1_internal',
          redactions: [],
          artifactRefs: payload.ok && payload.planId ? [`goal-plan://${payload.planId}`] : [],
        },
        completedAt: nowIso(),
      },
    };
  }

  async function executeUpdateTask(request, context = {}) {
    const call = request.call;
    const locale = context.locale ?? 'zh-CN';
    const args = parseArgs(call);

    const { planId, taskId } = args;
    let status = 'success';
    let payload;

    if (!planId || !taskId) {
      status = 'failed';
      payload = {
        ok: false,
        error: locale === 'zh-CN'
          ? 'goal_update_task 需要同时提供 planId 与 taskId。'
          : 'goal_update_task requires both planId and taskId.',
      };
    } else {
      try {
        const change = {};
        if (args.status !== undefined) change.status = args.status;
        if (args.evidenceRefs !== undefined) change.evidenceRefs = args.evidenceRefs;
        if (args.result !== undefined) change.result = args.result;
        if (args.failureReason !== undefined) change.failureReason = args.failureReason;
        if (args.blockedReason !== undefined) change.blockedReason = args.blockedReason;
        const plan = goalPlanStore.recordTaskEvidence(planId, taskId, change);
        if (!plan) {
          // store 在 plan 不存在时静默返回 null —— 视为失败，绝不伪装成功。
          status = 'failed';
          payload = {
            ok: false,
            error: locale === 'zh-CN'
              ? `未找到 Goal 计划：planId=${planId}。`
              : `Goal plan not found: planId=${planId}.`,
          };
        } else {
          payload = {
            ok: true,
            planId,
            taskId,
            taskStatus: change.status ?? null,
            progress: plan.progress ?? null,
            planStatus: plan.status ?? null,
          };
        }
      } catch (err) {
        status = 'failed';
        payload = {
          ok: false,
          error: err?.message ? String(err.message) : String(err),
        };
      }
    }

    const output = JSON.stringify(payload);

    return {
      call,
      grant: createPermissionGrant({
        toolCallId: call.toolCallId,
        granted: status === 'success',
        scope: GOAL_CAPABILITY_ID,
      }),
      result: {
        toolCallId: call.toolCallId,
        status,
        outputPreview: {
          status,
          tool: 'goal_update_task',
          legacyResult: { success: status === 'success', output },
        },
        evidence: {
          evidenceId: `goal-${call.toolCallId}`,
          toolCallId: call.toolCallId,
          summary: locale === 'zh-CN'
            ? `Goal 子任务回写：plan=${planId ?? '?'} task=${taskId ?? '?'} 状态=${status}。`
            : `Goal task evidence write: plan=${planId ?? '?'} task=${taskId ?? '?'} status=${status}.`,
          locale,
          returnedToCloud: false,
          dataLevel: 'D1_internal',
          redactions: [],
          artifactRefs: payload.ok && Array.isArray(args.evidenceRefs) ? args.evidenceRefs : [],
        },
        completedAt: nowIso(),
      },
    };
  }

  async function executeCapability(request, context = {}) {
    if (request?.call?.capabilityId === GOAL_CREATE_CAPABILITY_ID) {
      return executeCreatePlan(request, context);
    }
    return executeUpdateTask(request, context);
  }

  return {
    providerId: GOAL_CAPABILITY_ID,
    capabilityIds: [GOAL_CAPABILITY_ID, GOAL_CREATE_CAPABILITY_ID],
    executeCapability,
  };
}
