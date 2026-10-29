import { currentModelReview } from "./project-agent/criterion-review.mjs";
import { evaluateUiDelivery } from "@peer-agent/protocol";

// 可自动验证的成功标准类型（与 goal-plan-store 的 AUTO_CRITERION_KINDS 对齐）。
// 这些 kind 的标准必须有 passed=true 且带 evidenceRef 的验证结果才放行完成；
// 'manual' 则降级为 pre-finish 人工确认，不在此硬门拦截。
export const AUTO_VERIFIABLE_CRITERION_KINDS = new Set([
  'command',
  'test',
  'file-contains',
  'file-exists',
]);

function normalizeEvidenceRefSet(value) {
  if (!value) return null;
  const refs = value instanceof Set ? Array.from(value) : value;
  if (!Array.isArray(refs)) return null;
  return new Set(
    refs
      .filter((ref) => typeof ref === 'string' && ref.trim())
      .map((ref) => ref.trim()),
  );
}

function taskHasIndexedEvidence(task, indexedEvidenceRefs) {
  if (!indexedEvidenceRefs) return true;
  const refs = Array.isArray(task?.evidenceRefs) ? task.evidenceRefs : [];
  return refs.some((ref) => typeof ref === 'string' && indexedEvidenceRefs.has(ref.trim()));
}

function criterionEvidenceIsIndexed(evidenceRef, indexedEvidenceRefs) {
  if (!indexedEvidenceRefs) return true;
  return typeof evidenceRef === 'string' && indexedEvidenceRefs.has(evidenceRef.trim());
}

function latestManualDodConfirmation(plan, manualCriterionIds) {
  const expected = new Set(manualCriterionIds);
  if (expected.size === 0) return null;
  return (Array.isArray(plan?.manualConfirmations) ? plan.manualConfirmations : [])
    .filter((confirmation) => confirmation?.kind === 'manual_dod')
    .filter((confirmation) => Array.isArray(confirmation.criterionIds))
    .filter((confirmation) => {
      const ids = new Set(
        confirmation.criterionIds
          .filter((id) => typeof id === 'string' && id.trim())
          .map((id) => id.trim()),
      );
      for (const id of expected) {
        if (!ids.has(id)) return false;
      }
      return true;
    })
    .sort((a, b) => String(b.decidedAt || '').localeCompare(String(a.decidedAt || '')))[0] ?? null;
}

/**
 * 完成前验证门:遍历所有叶子任务,要求全部 status==='completed' 且 evidenceRefs 非空。
 * 任一叶子未完成或缺 Evidence 即不放行完成,返回 { passed:false, unmet:[...] }。
 * 这是"完成以证据为准、不能仅凭口头声明"的机器化落地。
 *
 * DoD-as-Code 增强（见 goal-mode-ultrathink-workflow 设计文档）：
 * - 若计划声明了 successCriteria，则在叶子证据之外，追加对成功标准的机器化校验：
 *   非 manual 的标准（command/test/file-contains/file-exists）必须有一条 passed=true
 *   且带 evidenceRef 的 CriterionResult，否则计入 unmet（reason=criterion_*）。
 * - manual 标准不在此拦截（由 pre-finish 一次人工确认承接），但会体现在 warnings。
 * - 若成功标准全为 manual（无任何可自动验证项），返回 weakDoD=true 告警，提示 DoD
 *   缺乏可执行验证——不阻断完成（向后兼容纯字符串 DoD），但让上层可感知并提示补强。
 */
export function evaluateVerificationGate(plan, options = {}) {
  const indexedEvidenceRefs = normalizeEvidenceRefSet(options.indexedEvidenceRefs);
  const requireManualConfirmation = options.requireManualConfirmation === true;
  // Host-resolved state only: never consume observations/judgments from a plan
  // patch or model arguments. Missing authority for a required review fails closed.
  const uiDeliveryRequired = options.uiDeliveryRequired === true;
  const uiDelivery = options.uiDelivery;
  const roots = Array.isArray(plan?.tasks) ? plan.tasks : [];
  const unmet = [];
  const warnings = [];
  if (uiDeliveryRequired) {
    if (!uiDelivery || !Array.isArray(uiDelivery.requirements) || uiDelivery.requirements.length === 0
      || !Array.isArray(uiDelivery.observations) || !Array.isArray(uiDelivery.judgments)) {
      unmet.push({ kind: 'ui_delivery', reason: 'ui_delivery_authority_missing' });
    } else {
      const review = evaluateUiDelivery(uiDelivery.requirements, uiDelivery.observations,
        uiDelivery.judgments, indexedEvidenceRefs ?? new Set());
      for (const gap of review.gaps) {
        unmet.push({ kind: 'ui_delivery', criterionId: gap.requirementId, reason: gap.reason });
      }
    }
  }
  let leaves = 0;
  const stack = [...roots];
  while (stack.length > 0) {
    const task = stack.pop();
    if (!task || typeof task !== 'object') continue;
    const subtasks = Array.isArray(task.subtasks) ? task.subtasks : [];
    if (subtasks.length > 0) {
      for (const child of subtasks) stack.push(child);
      continue;
    }
    leaves += 1;
    const done = task.status === 'completed';
    const hasEvidence = Array.isArray(task.evidenceRefs) && task.evidenceRefs.length > 0;
    const hasIndexedEvidence = hasEvidence && taskHasIndexedEvidence(task, indexedEvidenceRefs);
    // 条件叶子（例如“复核不通过才返工”）在前提不成立时会被取消。带已入索引证据的取消是
    // “有据可查的跳过”，不是未完成；无证据或证据未入索引的取消仍然拦截，避免用取消逃避工作。
    const documentedSkip = task.status === 'cancelled' && hasIndexedEvidence;
    if (!done && !documentedSkip) {
      unmet.push({
        kind: 'task',
        taskId: task.taskId ?? null,
        status: task.status ?? null,
        reason: task.status !== 'cancelled'
          ? 'not_completed'
          : hasEvidence
            ? 'unindexed_evidence'
            : 'cancelled_without_evidence',
      });
    } else if (!hasEvidence) {
      unmet.push({ kind: 'task', taskId: task.taskId ?? null, status: task.status ?? null, reason: 'missing_evidence' });
    } else if (!hasIndexedEvidence) {
      unmet.push({ kind: 'task', taskId: task.taskId ?? null, status: task.status ?? null, reason: 'unindexed_evidence' });
    }
  }
  // 无叶子任务(空计划)不视为通过——完成需要有可验证的证据基础。
  if (leaves === 0) return { passed: false, unmet: [], warnings, reason: 'no_leaf_tasks' };

  // DoD-as-Code：成功标准校验（有声明才检查，向后兼容无 successCriteria 的旧计划）。
  const criteria = Array.isArray(plan?.successCriteria) ? plan.successCriteria : [];
  if (criteria.length > 0) {
    const resultById = new Map(
      (Array.isArray(plan?.criterionResults) ? plan.criterionResults : [])
        .filter((r) => r && typeof r.criterionId === 'string')
        .map((r) => [r.criterionId, r]),
    );
    let autoCount = 0;
    const manualCriteria = [];
    for (const criterion of criteria) {
      if (!criterion || typeof criterion !== 'object') continue;
      const kind = typeof criterion.kind === 'string' ? criterion.kind : 'manual';
      const criterionId = typeof criterion.id === 'string' ? criterion.id : null;
      if (kind === 'model_review') {
        autoCount += 1;
        const review = currentModelReview(plan, criterionId);
        const refs = review?.evidenceRefs || [];
        if (review?.passed !== true || !refs.length || refs.some(ref => !criterionEvidenceIsIndexed(ref, indexedEvidenceRefs))) {
          unmet.push({ criterionId, kind, reason: !review ? 'criterion_unverified' : 'criterion_failed' });
        }
      } else if (AUTO_VERIFIABLE_CRITERION_KINDS.has(kind)) {
        autoCount += 1;
        const result = criterionId ? resultById.get(criterionId) : null;
        const passed = result?.passed === true;
        const hasRef = typeof result?.evidenceRef === 'string' && result.evidenceRef.trim();
        const hasIndexedRef = hasRef && criterionEvidenceIsIndexed(result.evidenceRef, indexedEvidenceRefs);
        if (!passed || !hasRef || !hasIndexedRef) {
          unmet.push({
            criterionId,
            kind,
            reason: !result
              ? 'criterion_unverified'
              : !passed
                ? 'criterion_failed'
                : !hasRef
                  ? 'criterion_missing_evidence'
                  : 'criterion_unindexed_evidence',
          });
        }
      } else {
        // manual 标准：不硬拦，转 pre-finish 人工确认，记 warning。
        if (criterionId) manualCriteria.push(criterion);
        warnings.push({ criterionId, kind, reason: 'manual_confirmation_required' });
      }
    }
    // 全 manual（无任何可自动验证项）：弱 DoD 告警——完成不阻断，但提示补强可执行验证。
    if (autoCount === 0) {
      warnings.push({ reason: 'weak_dod_all_manual' });
    }
    if (requireManualConfirmation && manualCriteria.length > 0) {
      const criterionIds = manualCriteria
        .map((criterion) => criterion.id)
        .filter((id) => typeof id === 'string' && id.trim());
      const confirmation = latestManualDodConfirmation(plan, criterionIds);
      const status = confirmation?.decision === 'approve'
        ? 'approved'
        : confirmation?.decision === 'reject'
          ? 'rejected'
          : confirmation?.decision === 'revise'
            ? 'revise'
            : 'missing';
      const manualConfirmation = {
        required: true,
        status,
        criterionIds,
        ...(confirmation?.confirmationId ? { confirmationId: confirmation.confirmationId } : {}),
      };
      if (status !== 'approved') {
        unmet.push({
          criterionId: criterionIds.join(','),
          kind: 'manual',
          reason: status === 'missing'
            ? 'manual_confirmation_required'
            : 'manual_confirmation_not_approved',
          manualConfirmation,
        });
      }
      return { passed: unmet.length === 0, unmet, warnings, manualConfirmation };
    }
  }

  return { passed: unmet.length === 0, unmet, warnings };
}

export function collectVerificationEvidenceRefs(plan) {
  const refs = new Set();
  const stack = Array.isArray(plan?.tasks) ? [...plan.tasks] : [];
  while (stack.length > 0) {
    const task = stack.pop();
    if (!task || typeof task !== 'object') continue;
    if (Array.isArray(task.evidenceRefs)) {
      for (const ref of task.evidenceRefs) {
        if (typeof ref === 'string' && ref.trim()) refs.add(ref.trim());
      }
    }
    const subtasks = Array.isArray(task.subtasks) ? task.subtasks : [];
    for (const child of subtasks) stack.push(child);
  }
  for (const result of Array.isArray(plan?.criterionResults) ? plan.criterionResults : []) {
    if (typeof result?.evidenceRef === 'string' && result.evidenceRef.trim()) {
      refs.add(result.evidenceRef.trim());
    }
  }
  return [...refs];
}

export function summarizeVerificationGate(gate) {
  if (gate?.passed) return 'Verification gate passed';
  if (gate?.reason === 'no_leaf_tasks') return 'Verification gate failed: no verifiable leaf tasks';
  const summary = Array.isArray(gate?.unmet)
    ? gate.unmet.map((u) => `${u.taskId ?? u.criterionId ?? '?'}:${u.reason}`).join('; ')
    : '';
  return `Verification gate failed${summary ? `: ${summary}` : ''}`;
}
