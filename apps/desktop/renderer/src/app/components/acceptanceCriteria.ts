import type { GoalCriterionResult, GoalPlan, GoalSuccessCriterion } from '@peer-agent/protocol';

export interface EvidenceLabelSource {
  readonly ref: string;
  readonly label?: string;
}

export interface AcceptanceCriterionRow {
  readonly criterion: GoalSuccessCriterion;
  readonly result: GoalCriterionResult | null;
}

/** 把成功标准与对照结果按 criterionId 对齐，供待验收页先看依据。 */
export function pairAcceptanceCriteria(plan: GoalPlan | null | undefined): readonly AcceptanceCriterionRow[] {
  const criteria = plan?.successCriteria ?? [];
  const results = new Map((plan?.criterionResults ?? []).map((result) => [result.criterionId, result]));
  return criteria.map((criterion) => ({
    criterion,
    result: results.get(criterion.id) ?? null,
  }));
}

/** 内部协议引用不得直接展示；验收页只给人看得懂的依据名。 */
export function formatEvidenceRef(ref: string | undefined, isZh = true): string | null {
  if (!ref?.trim()) return null;
  const value = ref.trim();
  if (value.startsWith('local-shell-artifact://')) {
    const tail = value.split('/').pop() ?? '';
    if (tail === 'stdout') return isZh ? '命令输出' : 'Command output';
    if (tail === 'stderr') return isZh ? '错误输出' : 'Error output';
    return isZh ? '命令执行结果' : 'Command result';
  }
  if (value.startsWith('tool-result://')) return isZh ? '工具结果' : 'Tool result';
  if (value.startsWith('goal-plan://')) return isZh ? '计划记录' : 'Plan record';
  if (value.startsWith('file://') || value.startsWith('/')) {
    const parts = value.replace(/^file:\/\//, '').split('/').filter(Boolean);
    return parts[parts.length - 1] ?? value;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    const rest = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    const parts = rest.split('/').filter(Boolean);
    return parts.slice(-2).join(' / ') || (isZh ? '证据' : 'Evidence');
  }
  return value;
}

export function resolveEvidenceLabel(
  ref: string | undefined,
  artifacts: readonly EvidenceLabelSource[] = [],
  isZh = true,
): string | null {
  if (!ref?.trim()) return null;
  const match = artifacts.find((artifact) => artifact.ref === ref);
  const labeled = match?.label?.trim();
  if (labeled && labeled !== ref) return labeled;
  return formatEvidenceRef(ref, isZh);
}

/** 验收页头只留工作区与合回状态，不拼 deliveryRoute / 进度分数。 */
export function acceptancePageMeta(item: {
  readonly workspaceLabel?: string | null;
  readonly deliveryHandoffLabel?: string | null;
}): readonly string[] {
  const bits: string[] = [];
  const workspace = item.workspaceLabel?.trim();
  const handoff = item.deliveryHandoffLabel?.trim();
  if (workspace) bits.push(workspace);
  if (handoff) bits.push(handoff);
  return bits;
}
