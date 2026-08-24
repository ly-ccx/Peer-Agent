import {
  LEGACY_LOCAL_CAPABILITY_ID_ALIASES,
  SHARED_LOCAL_TOOL_CONTRACTS,
  canonicalizeLocalCapabilityId,
} from '@peer-agent/runtime-core';

import { createGoalPlanStore } from '../goal-plan-store.mjs';
import { createPermissionGrant, nowIso } from './tool-result-factory.mjs';

/**
 * 本地 Plan / Goal 目标追踪能力 Provider —— 见 Plan 模式设计与 Goal 模式设计（运行时自动回写）。
 *
 * 设计要点（与 AGENTS.md 非协商运行时链一致）：
 * - Plan 模式使用这些能力建立审批前持久计划；Goal 模式使用同一套
 *   plan/task/evidence 结构做自驱目标追踪。agent 运行时在完成某子任务后，
 *   显式调用 `goal_update_task` 工具，把刚产生的 evidenceRefs 回写到对应子任务。
 * - 回写经正规链路：Capability Provider → Manifest → Runtime Projection → Tool Call
 *   → PermissionGrant → Evidence；不在中央工具链路里嗅探"当前活跃子任务"（那会污染
 *   host 且没有可靠的事实来源）。
 * - store 为纯磁盘型（无内存状态），provider 内用默认路径即可与主进程实例指向同一目录。
 * - "completed 必须带 evidenceRefs" 的治理约束由 store 强制；provider 仅转译失败为工具结果。
 */

const GOAL_CAPABILITY_ID = SHARED_LOCAL_TOOL_CONTRACTS.goalUpdateTask.capabilityId;
const GOAL_CREATE_CAPABILITY_ID = SHARED_LOCAL_TOOL_CONTRACTS.goalCreatePlan.capabilityId;
const GOAL_READ_CAPABILITY_ID = SHARED_LOCAL_TOOL_CONTRACTS.goalGetPlan.capabilityId;
const GOAL_EXPLORE_CAPABILITY_ID = SHARED_LOCAL_TOOL_CONTRACTS.requestExplorer.capabilityId;
const LEGACY_GOAL_CAPABILITY_IDS = Object.freeze(
  Object.keys(LEGACY_LOCAL_CAPABILITY_ID_ALIASES).filter((capabilityId) => (
    canonicalizeLocalCapabilityId(capabilityId).startsWith('local.goal.')
  )),
);

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

/**
 * 计划标题兜底：title 在 schema 中已标为 required 且 prompt 明确要求，模型正常都会给；
 * 本函数仅为极端情况下模型仍漏传 title 的兜底，避免落空串让面板显示“未命名计划”。
 * 兜底时用 goal 首句（截断）凑一个可读标题。纯本地推导，不引入云端事实，符合“本地负责能力”。
 */
function deriveTitle(rawTitle, goal) {
  const title = typeof rawTitle === 'string' ? rawTitle.trim() : '';
  if (title) return title;
  const source = typeof goal === 'string' ? goal.trim() : '';
  if (!source) return '';
  const firstLine = source.split(/\r?\n/)[0].trim();
  const firstSentence = firstLine.split(/(?<=[。．.!？?])/)[0].trim() || firstLine;
  return firstSentence.length > 40 ? `${firstSentence.slice(0, 40)}…` : firstSentence;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

const EXPLICIT_NEW_REQUEST_RE = /(?:新需求|新任务|新目标|另开|另外做|换个|无关|unrelated|new request|new goal|separate task|different topic)/i;

export function looksLikeExplicitNewRequest(text) {
  return EXPLICIT_NEW_REQUEST_RE.test(String(text || ''));
}

function pickSourceTaskId(plan) {
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
  const match = tasks.find((task) => task && typeof task.taskId === 'string' && task.taskId.trim());
  return match ? match.taskId.trim() : null;
}

function pickRecentCompletedPlan(details) {
  const completed = (Array.isArray(details) ? details : [])
    .filter((plan) => plan && typeof plan === 'object' && plan.status === 'completed' && plan.planId)
    .slice();
  completed.sort((a, b) => {
    const at = Date.parse(a.completedAt || a.updatedAt || a.createdAt || '') || 0;
    const bt = Date.parse(b.completedAt || b.updatedAt || b.createdAt || '') || 0;
    return bt - at;
  });
  return completed[0] || null;
}

/**
 * 验收后追问时，模型可能漏填关系字段。同会话有最近完成计划、且文案不像明确新需求时，
 * 自动补 parentPlanId + 父计划上真实存在的 sourceTaskId。
 * 显式传入的字段优先；只补缺失的那一侧，避免覆盖模型选择。
 */
export function resolveDerivedPlanRelation({
  parentPlanId,
  sourceTaskId,
  title,
  goal,
  recentCompleted,
} = {}) {
  const explicitParent = nonEmptyString(parentPlanId);
  const explicitSource = nonEmptyString(sourceTaskId);
  if (explicitParent && explicitSource) {
    return { parentPlanId: explicitParent, sourceTaskId: explicitSource, attached: false };
  }
  if (looksLikeExplicitNewRequest(`${title || ''} ${goal || ''}`)) {
    return {
      ...(explicitParent ? { parentPlanId: explicitParent } : {}),
      ...(explicitSource ? { sourceTaskId: explicitSource } : {}),
      attached: false,
    };
  }
  const parentId = explicitParent || nonEmptyString(recentCompleted?.planId);
  const sourceId = explicitSource || pickSourceTaskId(recentCompleted);
  if (!parentId || !sourceId) {
    return {
      ...(explicitParent ? { parentPlanId: explicitParent } : {}),
      ...(explicitSource ? { sourceTaskId: explicitSource } : {}),
      attached: false,
    };
  }
  return { parentPlanId: parentId, sourceTaskId: sourceId, attached: !explicitParent || !explicitSource };
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

/**
 * 把（可能含子树的）任务树拍平为 {taskId,title,status,evidenceRefs} 紧凑清单，
 * 供 Tool Result 回显与 goal_get_plan 读回使用。叶子优先，保留创建顺序。
 */
function summarizeTasks(tasks) {
  const out = [];
  const walk = (list) => {
    if (!Array.isArray(list)) return;
    for (const t of list) {
      if (!t || typeof t !== 'object') continue;
      out.push({
        taskId: typeof t.taskId === 'string' ? t.taskId : null,
        title: typeof t.title === 'string' ? t.title : '',
        status: typeof t.status === 'string' ? t.status : 'pending',
        evidenceRefs: Array.isArray(t.evidenceRefs) ? t.evidenceRefs : [],
      });
      const children = Array.isArray(t.subtasks) ? t.subtasks : [];
      if (children.length > 0) walk(children);
    }
  };
  walk(tasks);
  return out;
}

/** 把一个计划精简为只读读回结构（goal_get_plan 用）。 */
function summarizePlan(plan) {
  if (!plan || typeof plan !== 'object') return null;
  return {
    planId: plan.planId,
    title: plan.title ?? '',
    goal: plan.goal ?? '',
    status: plan.status ?? null,
    originWorkspacePath: plan.originWorkspacePath ?? null,
    targetWorkspacePath: plan.targetWorkspacePath ?? null,
    progress: plan.progress ?? null,
    tasks: summarizeTasks(plan.tasks),
  };
}

export function createLocalGoalProvider({ goalPlanStore = createGoalPlanStore() } = {}) {
  async function executeCreatePlan(request, context = {}) {
    const call = request.call;
    const locale = context.locale ?? 'zh-CN';
    const args = parseArgs(call);
    const conversationId = context.toolContext?.conversationId ?? null;
    const mode = context.toolContext?.mode ?? 'chat';
    // Agent 的 legacy wire value 仍可能是 chat；与 legacy goal 一样都走自驱契约。
    // 保持在函数作用域，因为创建后的 Tool Result / control signal 也需要此判定。
    const selfDriven = mode === 'goal' || mode === 'chat';
    const originWorkspacePath =
      nonEmptyString(args.originWorkspacePath) ||
      nonEmptyString(context.toolContext?.originWorkspacePath) ||
      nonEmptyString(context.toolContext?.workspacePath);
    const targetWorkspacePath =
      nonEmptyString(args.targetWorkspacePath) ||
      nonEmptyString(context.toolContext?.targetWorkspacePath) ||
      originWorkspacePath;

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
        const recentCompleted = conversationId
          && typeof goalPlanStore.listPlanDetailsByConversation === 'function'
          ? pickRecentCompletedPlan(goalPlanStore.listPlanDetailsByConversation(conversationId))
          : (conversationId && typeof goalPlanStore.getUnacceptedCompletedPlanByConversation === 'function'
            ? goalPlanStore.getUnacceptedCompletedPlanByConversation(conversationId)
            : null);
        const relation = resolveDerivedPlanRelation({
          parentPlanId: args.parentPlanId,
          sourceTaskId: args.sourceTaskId,
          title: args.title,
          goal: args.goal,
          recentCompleted,
        });
        const draft = {
          conversationId,
          title: deriveTitle(args.title, args.goal),
          goal: args.goal,
          ...(originWorkspacePath ? { originWorkspacePath } : {}),
          ...(targetWorkspacePath ? { targetWorkspacePath } : {}),
          // 目标线派生：模型成对传入，或执行器按最近完成计划补挂。
          ...(relation.parentPlanId ? { parentPlanId: relation.parentPlanId } : {}),
          ...(relation.sourceTaskId ? { sourceTaskId: relation.sourceTaskId } : {}),
          tasks: normalizeTasks(args.tasks),
          // 可选的结构化成功标准（DoD）。store 层会规范化（字符串→manual 向后兼容），
          // 缺省时归一为空数组，不影响既有仅传 goal/tasks 的调用。
          successCriteria: args.successCriteria,
          createdBy: 'agent',
        };
        // Agent 默认（chat）与 legacy goal：创建即 accepted 自驱契约；plan 模式仍走 awaiting_approval。
        const plan = selfDriven && typeof goalPlanStore.upsertGoalContract === 'function'
          ? goalPlanStore.upsertGoalContract(conversationId, {
            ...draft,
            status: 'accepted',
            workflowKind: 'goal_self_driven',
            activation: {
              kind: 'accepted_goal',
              acceptedAt: new Date().toISOString(),
              acceptedBy: 'user',
            },
          })
          : goalPlanStore.createPlan({
            ...draft,
            status: 'awaiting_approval',
            workflowKind: 'plan_approval',
            activation: { kind: 'approval_required' },
          });
        payload = {
          ok: true,
          planId: plan.planId,
          status: plan.status,
          workflowKind: plan.workflowKind,
          activation: plan.activation,
          originWorkspacePath: plan.originWorkspacePath ?? null,
          targetWorkspacePath: plan.targetWorkspacePath ?? null,
          taskCount: plan.tasks?.length ?? 0,
          progress: plan.progress ?? null,
          // 权威 taskId 清单：第一时间把 store 生成的 taskId 经 Tool Result 回显给模型，
          // 避免后续 goal_update_task 凭记忆/被压缩历史猜 taskId（见 0006 提案根因 1）。
          tasks: summarizeTasks(plan.tasks),
          note: selfDriven
            ? (locale === 'zh-CN'
              ? 'Goal 契约已接受。Runner 可在边界内自驱推进；子任务完成、失败或阻塞时请用上面 tasks[].taskId 回写 Evidence。'
              : 'Goal contract accepted. The runner may continue autonomously within boundaries; use tasks[].taskId above when writing back evidence.')
            : (locale === 'zh-CN'
              ? '计划已创建并等待用户批准。请通过计划面板/批准卡取得批准后再执行。回写子任务请使用上面 tasks[].taskId。'
              : 'Plan created and awaiting approval. Get approval via the Plan panel/approval card before executing. Use tasks[].taskId above when writing back subtasks.'),
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
          // Goal 创建是 intake 与托管执行之间的明确边界：当前 agent loop 在工具结果
          // 落证后停止回灌，再由 main 编排层于本回合结束后启动 Goal Runner。
          // Plan 模式仍等待审批，因此不能携带此终止信号。
          ...(status === 'success' && selfDriven
            ? { control: { terminal: true, reason: 'goal_handoff' } }
            : {}),
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
        let plan = goalPlanStore.recordTaskEvidence(planId, taskId, change);
        // DoD-as-Code：若本次回写附带成功标准的验证结果，路由到 store 落盘。
        // 与任务证据回写同调用完成，让模型 post-act 验证后一步回写（不新开旁路）。
        if (plan && args.criterionResults !== undefined
          && typeof goalPlanStore.recordCriterionResults === 'function') {
          const afterCriteria = goalPlanStore.recordCriterionResults(planId, args.criterionResults);
          if (afterCriteria) plan = afterCriteria;
        }
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
            criterionResults: Array.isArray(plan.criterionResults) ? plan.criterionResults : [],
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

  /**
   * 只读读回计划（goal_get_plan）。compaction 后模型可凭此把权威 taskId 拉回。
   * - 传 planId：返回该计划精简结构。
   * - 不传 planId：按当前会话返回活动计划列表（精简）。
   * 不写盘、不触发授权交互（L0_inert）。
   */
  async function executeGetPlan(request, context = {}) {
    const call = request.call;
    const locale = context.locale ?? 'zh-CN';
    const args = parseArgs(call);
    const conversationId = context.toolContext?.conversationId ?? null;

    let status = 'success';
    let payload;
    try {
      const planId = typeof args.planId === 'string' && args.planId ? args.planId : null;
      if (planId) {
        const plan = summarizePlan(goalPlanStore.getPlan(planId));
        if (!plan) {
          status = 'failed';
          payload = {
            ok: false,
            error: locale === 'zh-CN'
              ? `未找到 Goal 计划：planId=${planId}。`
              : `Goal plan not found: planId=${planId}.`,
          };
        } else {
          payload = { ok: true, plan };
        }
      } else {
        const details = typeof goalPlanStore.listPlanDetailsByConversation === 'function'
          ? goalPlanStore.listPlanDetailsByConversation(conversationId)
          : [];
        payload = {
          ok: true,
          conversationId,
          plans: (Array.isArray(details) ? details : []).map(summarizePlan).filter(Boolean),
        };
      }
    } catch (err) {
      status = 'failed';
      payload = { ok: false, error: err?.message ? String(err.message) : String(err) };
    }

    const output = JSON.stringify(payload);
    return {
      call,
      grant: createPermissionGrant({
        toolCallId: call.toolCallId,
        granted: status === 'success',
        scope: GOAL_READ_CAPABILITY_ID,
      }),
      result: {
        toolCallId: call.toolCallId,
        status,
        outputPreview: {
          status,
          tool: 'goal_get_plan',
          legacyResult: { success: status === 'success', output },
        },
        evidence: {
          evidenceId: `goal-read-${call.toolCallId}`,
          toolCallId: call.toolCallId,
          summary: locale === 'zh-CN'
            ? `Goal 计划读回：${args.planId ? `planId=${args.planId}` : `conversation=${conversationId ?? '?'}`}。`
            : `Goal plan read: ${args.planId ? `planId=${args.planId}` : `conversation=${conversationId ?? '?'}`}.`,
          locale,
          returnedToCloud: false,
          dataLevel: 'D1_internal',
          redactions: [],
          artifactRefs: payload.ok && args.planId ? [`goal-plan://${args.planId}`] : [],
        },
        completedAt: nowIso(),
      },
    };
  }

  /**
   * request_explorer：登记一个只读 Explorer 子 Agent 请求。
   * 本执行器不直接做探查——它只把模型给的 question/reason/scope 回灌为一次成功的
   * 工具结果（ack）。真正的派发/执行由 Goal Runner 在回合结束后，经
   * agentProgress.onToolCall 收集到的请求做 dispatchExplorer → runExplorer。
   * 因此本能力无外部副作用（L0_inert）。
   */
  async function executeRequestExplorer(request, context = {}) {
    const call = request.call;
    const locale = context.locale ?? 'zh-CN';
    const args = parseArgs(call);
    const question = typeof args.question === 'string' ? args.question.trim() : '';
    let status = 'success';
    let payload;
    if (!question) {
      status = 'failed';
      payload = {
        ok: false,
        error: locale === 'zh-CN'
          ? 'request_explorer 需要提供 question（要探查的只读问题）。'
          : 'request_explorer requires a question (the read-only question to investigate).',
      };
    } else {
      payload = {
        ok: true,
        accepted: true,
        question,
        message: locale === 'zh-CN'
          ? 'Explorer 请求已登记，将由 Goal Runner 在本回合结束后派发执行。'
          : 'Explorer request registered; the Goal Runner will dispatch it after this turn.',
      };
    }

    const output = JSON.stringify(payload);
    return {
      call,
      grant: createPermissionGrant({
        toolCallId: call.toolCallId,
        granted: status === 'success',
        scope: GOAL_EXPLORE_CAPABILITY_ID,
      }),
      result: {
        toolCallId: call.toolCallId,
        status,
        outputPreview: {
          status,
          tool: 'request_explorer',
          legacyResult: { success: status === 'success', output },
        },
        evidence: {
          evidenceId: `goal-explore-${call.toolCallId}`,
          toolCallId: call.toolCallId,
          summary: locale === 'zh-CN'
            ? `Explorer 请求登记：${question || '(缺少 question)'}。`
            : `Explorer request registered: ${question || '(missing question)'}.`,
          locale,
          returnedToCloud: false,
          dataLevel: 'D1_internal',
          redactions: [],
          artifactRefs: [],
        },
        completedAt: nowIso(),
      },
    };
  }

  async function executeCapability(request, context = {}) {
    const capabilityId = canonicalizeLocalCapabilityId(request?.call?.capabilityId ?? '');
    const normalizedRequest = capabilityId === request?.call?.capabilityId
      ? request
      : {
          ...request,
          call: {
            ...request?.call,
            capabilityId,
          },
        };
    if (capabilityId === GOAL_CREATE_CAPABILITY_ID) {
      return executeCreatePlan(normalizedRequest, context);
    }
    if (capabilityId === GOAL_READ_CAPABILITY_ID) {
      return executeGetPlan(normalizedRequest, context);
    }
    if (capabilityId === GOAL_EXPLORE_CAPABILITY_ID) {
      return executeRequestExplorer(normalizedRequest, context);
    }
    return executeUpdateTask(normalizedRequest, context);
  }

  return {
    providerId: GOAL_CAPABILITY_ID,
    capabilityIds: [
      GOAL_CAPABILITY_ID,
      GOAL_CREATE_CAPABILITY_ID,
      GOAL_READ_CAPABILITY_ID,
      GOAL_EXPLORE_CAPABILITY_ID,
      ...LEGACY_GOAL_CAPABILITY_IDS,
    ],
    executeCapability,
  };
}
