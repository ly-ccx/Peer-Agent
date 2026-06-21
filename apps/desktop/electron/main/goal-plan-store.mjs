import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  renameSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathOf } from './data-store.mjs';

/**
 * Goal 计划持久化 store —— 见 Goal 模式设计。
 *
 * 设计要点（与提案 §3/§4/§6 一致）：
 * - 计划是持久化的 Evidence/artifact，目录型多记录：index.jsonl（轻量元信息，
 *   用于列表）+ 每个计划一个 `${planId}.json`（全量 GoalPlan）。
 * - 原子写：先写 `.tmp` 再 rename，避免半截文件损坏。
 * - 子任务（含嵌套）状态只能由 Evidence 回写；置为 'completed' 必须带 evidenceRefs。
 * - progress 由子任务自底向上聚合，调用方不可手填（每次写入都会重算覆盖）。
 *
 * 协议类型见 packages/protocol/src/goal.ts。本模块只依赖 fs/path/crypto，
 * 不 import electron，可被单测直接 import。
 */

function readJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function appendJsonl(filePath, obj) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
}

function writeJsonl(filePath, items) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, items.map((item) => JSON.stringify(item)).join('\n') + '\n', 'utf8');
  renameSync(tmp, filePath);
}

function writeJsonAtomic(filePath, obj) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  renameSync(tmp, filePath);
}

function readJson(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/** ExecutionStatus（execution.ts）——本 store 仅依赖这些字面量做聚合判定。 */
const TERMINAL_OK = 'completed';
const TERMINAL_FAIL = 'failed';
const BLOCKED = 'waiting_user';

/**
 * 自底向上聚合进度。约束（提案 §4）：
 * - 只统计叶子任务（无 subtasks 的任务）；父任务状态由叶子派生，不单独计数。
 * - completed / failed / blocked 分别计数，percent = completed / total * 100。
 *
 * @param {Array} tasks 顶层子任务树
 * @returns {{total:number,completed:number,failed:number,blocked:number,percent:number}}
 */
export function aggregateProgress(tasks) {
  let total = 0;
  let completed = 0;
  let failed = 0;
  let blocked = 0;

  const walk = (list) => {
    for (const t of list || []) {
      const children = Array.isArray(t.subtasks) ? t.subtasks : [];
      if (children.length > 0) {
        walk(children);
        continue;
      }
      // 叶子任务
      total += 1;
      if (t.status === TERMINAL_OK) completed += 1;
      else if (t.status === TERMINAL_FAIL) failed += 1;
      else if (t.status === BLOCKED) blocked += 1;
    }
  };
  walk(tasks);

  const percent = total === 0 ? 0 : Math.round((completed / total) * 100);
  return { total, completed, failed, blocked, percent };
}

/**
 * 由子任务事实自底向上派生「计划整体状态」，与 aggregateProgress 同源（提案 §4/§6）。
 *
 * 负责两种「只前进」的派生（均与 aggregateProgress 同源、由叶子事实驱动、纯函数、不回退）：
 *
 * 1. 开工推进：当计划尚处于「执行前」状态（awaiting_approval / approved），
 *    但已有任意子任务进入活跃或终态（running / completed / failed / waiting_user）时，
 *    说明执行已经开始（典型场景：用户在对话里直接触发执行，跳过了面板审批按钮），
 *    此时把计划推进到 'executing'，从而让审批按钮（canDecide=awaiting_approval）正确消失。
 *
 * 2. 自动收尾（见 Goal 计划自动收尾设计）：当计划已 'executing'
 *    且存在叶子、且所有叶子均为终态（completed / failed）时，把顶层推进到终态——
 *    含任一 failed → 'failed'，否则全 completed → 'completed'。这修复了「子任务 100%
 *    完成但顶层仍显示 executing」的现象。waiting_user（阻塞）叶子不算终态，存在它时不收尾；
 *    空计划（无叶子）不收尾。
 *
 * 不做任何回退（已是 completed/failed/cancelled/paused 等终态/显式态不会被改回），
 * 避免与 recordApproval / setPlanStatus 的显式状态机产生竞争。
 *
 * @param {string} currentStatus 当前 plan.status
 * @param {Array} tasks 顶层子任务树
 * @returns {string} 派生后的 plan.status
 */
export function derivePlanStatus(currentStatus, tasks) {
  // 规则 2：executing + 全叶子终态 → 自动收尾（completed/failed）。
  if (currentStatus === 'executing') {
    let leafTotal = 0;
    let allTerminal = true;
    let hasFailed = false;
    const walkLeaves = (list) => {
      for (const t of list || []) {
        const children = Array.isArray(t.subtasks) ? t.subtasks : [];
        if (children.length > 0) {
          walkLeaves(children);
          continue;
        }
        leafTotal += 1;
        if (t.status === TERMINAL_FAIL) hasFailed = true;
        else if (t.status !== TERMINAL_OK) allTerminal = false;
      }
    };
    walkLeaves(tasks);
    if (leafTotal > 0 && allTerminal) {
      return hasFailed ? TERMINAL_FAIL : TERMINAL_OK;
    }
    return currentStatus;
  }

  // 规则 1：执行前 → executing（一旦有叶子开工）。
  const PRE_EXECUTION = new Set(['awaiting_approval', 'approved']);
  if (!PRE_EXECUTION.has(currentStatus)) return currentStatus;

  let started = false;
  const walk = (list) => {
    for (const t of list || []) {
      if (started) return;
      const children = Array.isArray(t.subtasks) ? t.subtasks : [];
      if (children.length > 0) {
        walk(children);
        continue;
      }
      if (
        t.status === 'running' ||
        t.status === TERMINAL_OK ||
        t.status === TERMINAL_FAIL ||
        t.status === BLOCKED
      ) {
        started = true;
        return;
      }
    }
  };
  walk(tasks);

  return started ? 'executing' : currentStatus;
}

/**
 * 在任务树里按 taskId 定位并以 updater 产生的新对象替换（不可变更新）。
 * @returns {{tasks:Array, found:boolean}}
 */
function updateTaskInTree(tasks, taskId, updater) {
  let found = false;
  const map = (list) =>
    (list || []).map((t) => {
      if (t.taskId === taskId) {
        found = true;
        return updater(t);
      }
      if (Array.isArray(t.subtasks) && t.subtasks.length > 0) {
        const next = map(t.subtasks);
        return { ...t, subtasks: next };
      }
      return t;
    });
  const next = map(tasks);
  return { tasks: next, found };
}

function normalizeConversationId(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizePlan(plan) {
  if (!plan) return null;
  const normalizedConversationId = normalizeConversationId(plan.conversationId);
  const approvalDecision = plan.approval?.decision;
  const normalizedStatus = approvalDecision === 'reject' && plan.status !== 'cancelled'
    ? 'cancelled'
    : plan.status;
  return {
    ...plan,
    conversationId: normalizedConversationId ?? undefined,
    status: normalizedStatus,
  };
}

function isInactivePlan(plan) {
  return plan?.status === 'cancelled';
}

export function createGoalPlanStore({ storeDir = pathOf('goalPlans'), onChange } = {}) {
  const indexFile = path.join(storeDir, 'index.jsonl');

  // 变更通知 Seam：任何写操作（create/revise/approve/setStatus/recordTaskEvidence/delete）
  // 完成后触发 onChange，使 main 进程可向 renderer 广播 'goalPlans:changed'。
  // 收口于此，AI 工具路径（local-goal-provider）与 IPC 路径共享同一通知，
  // 无需在每个调用点重复挂广播。回调异常被吞掉，绝不影响写盘结果。
  function notifyChanged(reason, planId) {
    if (typeof onChange !== 'function') return;
    try {
      onChange({ reason, planId: planId ?? null });
    } catch (err) {
      // 广播失败不影响写盘结果，但显式打印以便排查（不要静默吞）。
      console.warn('[goal-plan-store] onChange broadcast failed:', err);
    }
  }

  function planFile(id) {
    return path.join(storeDir, `${id}.json`);
  }

  function readIndex() {
    return readJsonl(indexFile);
  }

  function toMeta(plan) {
    return {
      planId: plan.planId,
      title: plan.title,
      status: plan.status,
      conversationId: plan.conversationId ?? null,
      threadId: plan.threadId ?? null,
      version: plan.version,
      percent: plan.progress?.percent ?? 0,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
    };
  }

  function syncIndex(plan) {
    const index = readIndex().filter((m) => m.planId !== plan.planId);
    index.push(toMeta(plan));
    writeJsonl(indexFile, index);
  }

  function persist(plan) {
    // progress 始终由子任务聚合派生，写入前强制重算覆盖（不可手填）。
    const normalized = normalizePlan(plan);
    const next = {
      ...normalized,
      // 计划整体状态与 progress 同源：仅「执行前 → executing」的只前进派生，
      // 让对话直接触发执行的场景也能正确收起面板审批按钮。
      status: derivePlanStatus(normalized.status, normalized.tasks),
      progress: aggregateProgress(normalized.tasks),
    };
    writeJsonAtomic(planFile(next.planId), next);
    syncIndex(next);
    notifyChanged('persist', next.planId);
    return next;
  }

  function activeMeta(meta) {
    return !isInactivePlan(meta);
  }

  function listPlans() {
    return readIndex()
      .map(normalizePlan)
      .filter((m) => m && activeMeta(m))
      .sort((a, b) =>
        String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')),
      );
  }

  function listPlansByConversation(conversationId) {
    const normalizedConversationId = normalizeConversationId(conversationId);
    if (normalizedConversationId === null) return [];
    return listPlans().filter((m) => normalizeConversationId(m.conversationId) === normalizedConversationId);
  }

  function hydratePlanMeta(meta) {
    if (!meta?.planId) return null;
    const plan = getPlan(meta.planId);
    if (!plan || isInactivePlan(plan)) return null;
    if (plan.progress) return plan;
    return { ...plan, progress: aggregateProgress(plan.tasks) };
  }

  function listPlanDetails() {
    return listPlans().map(hydratePlanMeta).filter(Boolean);
  }

  function listPlanDetailsByConversation(conversationId) {
    const normalizedConversationId = normalizeConversationId(conversationId);
    if (normalizedConversationId === null) return [];
    return listPlansByConversation(normalizedConversationId).map(hydratePlanMeta).filter(Boolean);
  }

  function getPlan(planId) {
    return normalizePlan(readJson(planFile(planId)));
  }

  /**
   * 创建草稿计划（status='drafting'）。progress 由 tasks 聚合派生。
   */
  function createPlan(draft = {}) {
    const now = new Date().toISOString();
    const tasks = Array.isArray(draft.tasks) ? draft.tasks : [];
    const plan = {
      planId: draft.planId || randomUUID(),
      conversationId: normalizeConversationId(draft.conversationId) ?? undefined,
      threadId: draft.threadId,
      agentId: draft.agentId,
      title: draft.title || '',
      goal: draft.goal || '',
      successCriteria: draft.successCriteria || [],
      boundaries: draft.boundaries || { inScope: [], outOfScope: [] },
      exceptionPolicies: draft.exceptionPolicies || [],
      involvedFiles: draft.involvedFiles || [],
      tasks,
      status: draft.status || 'drafting',
      approval: draft.approval,
      progress: aggregateProgress(tasks),
      version: 1,
      revisionHistory: [],
      evidenceRefs: draft.evidenceRefs || [],
      promptContextEpochId: draft.promptContextEpochId,
      createdAt: now,
      updatedAt: now,
      createdBy: draft.createdBy,
    };
    return persist(plan);
  }

  /**
   * 修订计划内容（先规划阶段的反复修改 / revise）。
   * 递增 version，并向 revisionHistory 追加一条。progress 自动重算。
   * 不允许通过本方法直接改 progress（会被忽略并重算）。
   */
  function revisePlan(planId, patch = {}, { reason, changedBy } = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const { progress: _ignore, version: _v, revisionHistory: _rh, ...safePatch } = patch;
    const nextVersion = (plan.version || 1) + 1;
    const next = {
      ...plan,
      ...safePatch,
      version: nextVersion,
      revisionHistory: [
        ...(plan.revisionHistory || []),
        {
          version: nextVersion,
          reason: reason || '',
          changedAt: new Date().toISOString(),
          changedBy,
        },
      ],
      updatedAt: new Date().toISOString(),
    };
    return persist(next);
  }

  /**
   * 记录批准事实（Evidence），并按决策推进计划状态机：
   * - approve → 'approved'
   * - reject  → 回到 'drafting'
   * - revise  → 'drafting'（等待修订）
   */
  function recordApproval(planId, approval = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const decision = approval.decision;
    let status = plan.status;
    if (decision === 'approve') status = 'approved';
    else if (decision === 'reject') status = 'cancelled';
    else if (decision === 'revise') status = 'drafting';
    const next = {
      ...plan,
      approval: {
        decision,
        confirmationId: approval.confirmationId || randomUUID(),
        decidedBy: approval.decidedBy,
        decidedAt: approval.decidedAt || new Date().toISOString(),
        feedback: approval.feedback,
      },
      status,
      updatedAt: new Date().toISOString(),
    };
    return persist(next);
  }

  /** 推进计划整体状态（executing / paused / completed / cancelled / failed）。 */
  function setPlanStatus(planId, status) {
    const plan = getPlan(planId);
    if (!plan) return null;
    return persist({ ...plan, status, updatedAt: new Date().toISOString() });
  }

  /**
   * 由 Evidence 回写子任务状态。约束（提案 §6）：
   * - 置为 'completed' 必须提供非空 evidenceRefs，否则抛错。
   * - progress 在 persist 时自动重算。
   *
   * @param {string} planId
   * @param {string} taskId
   * @param {{status:string, evidenceRefs?:string[], result?:string,
   *          failureReason?:string, blockedReason?:string}} change
   */
  function recordTaskEvidence(planId, taskId, change = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const { status } = change;
    const mergedRefs = (refs, add) => {
      const set = new Set([...(refs || []), ...(add || [])]);
      return [...set];
    };
    if (status === TERMINAL_OK) {
      const incoming = change.evidenceRefs || [];
      if (incoming.length === 0) {
        // 也允许任务已有历史 evidenceRefs 的情况，但 completed 必须有至少一条。
        const existing = (() => {
          let found = null;
          const walk = (list) => {
            for (const t of list || []) {
              if (t.taskId === taskId) found = t;
              else if (t.subtasks) walk(t.subtasks);
            }
          };
          walk(plan.tasks);
          return found?.evidenceRefs || [];
        })();
        if (existing.length === 0) {
          throw new Error(
            `[goal-plan-store] task ${taskId} cannot be 'completed' without evidenceRefs`,
          );
        }
      }
    }
    const now = new Date().toISOString();
    const { tasks, found } = updateTaskInTree(plan.tasks, taskId, (t) => {
      const nextRefs = mergedRefs(t.evidenceRefs, change.evidenceRefs);
      const updated = {
        ...t,
        status: status ?? t.status,
        evidenceRefs: nextRefs,
      };
      if (change.result !== undefined) updated.result = change.result;
      if (change.failureReason !== undefined) updated.failureReason = change.failureReason;
      if (change.blockedReason !== undefined) updated.blockedReason = change.blockedReason;
      if (status === 'running' && !t.startedAt) updated.startedAt = now;
      if (status === TERMINAL_OK || status === TERMINAL_FAIL) updated.completedAt = now;
      return updated;
    });
    if (!found) {
      throw new Error(`[goal-plan-store] task ${taskId} not found in plan ${planId}`);
    }
    return persist({ ...plan, tasks, updatedAt: now });
  }

  function deletePlan(planId) {
    const index = readIndex().filter((m) => m.planId !== planId);
    writeJsonl(indexFile, index);
    try {
      if (existsSync(planFile(planId))) unlinkSync(planFile(planId));
    } catch {}
    notifyChanged('delete', planId);
    return listPlans();
  }

  /**
   * 级联删除：硬删除某个会话名下的全部计划（见 ADR 34）。
   *
   * 用于「删除会话」时联动清理其计划，避免孤儿计划文件/索引行。
   * 设计约束：
   * - conversationId 归一化为 null（空/未传）时直接 no-op，绝不按 `null === null`
   *   去匹配——否则会误删那些「未关联任何会话」的计划。
   * - 基于 index 行的 conversationId 即可筛选，无需逐个读 plan 文件。
   * - 原子重写 index（一次写盘），再逐个 unlink 计划文件；删除若干计划只广播一次
   *   onChange，复用既有 Seam（renderer 仍走 goalPlans:changed 刷新）。
   *
   * @param {string|null|undefined} conversationId 目标会话 id
   * @returns {Array} 删除后剩余的计划元信息列表（listPlans 形态）
   */
  function deletePlanByConversation(conversationId) {
    const normalizedConversationId = normalizeConversationId(conversationId);
    // 空会话 id 是 no-op：不删除任何计划（尤其不能误删未关联会话的计划）。
    if (normalizedConversationId === null) return listPlans();

    const index = readIndex();
    const removed = index.filter(
      (m) => normalizeConversationId(m.conversationId) === normalizedConversationId,
    );
    if (removed.length === 0) return listPlans();

    const remaining = index.filter(
      (m) => normalizeConversationId(m.conversationId) !== normalizedConversationId,
    );
    // 先原子重写 index（一次写盘），再删除各计划文件。
    writeJsonl(indexFile, remaining);
    for (const meta of removed) {
      try {
        if (existsSync(planFile(meta.planId))) unlinkSync(planFile(meta.planId));
      } catch {}
    }
    // 批量删除只广播一次，避免抖动；planId 传 null 表示非单一计划变更。
    notifyChanged('delete', null);
    return listPlans();
  }

  return {
    listPlans,
    listPlansByConversation,
    listPlanDetails,
    listPlanDetailsByConversation,
    getPlan,
    createPlan,
    revisePlan,
    recordApproval,
    setPlanStatus,
    recordTaskEvidence,
    deletePlan,
    deletePlanByConversation,
  };
}
