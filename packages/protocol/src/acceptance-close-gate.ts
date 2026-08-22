import type { GoalCriterionResult, GoalManualConfirmation, GoalSuccessCriterion } from './goal.ts';

const AUTO_CRITERION_KINDS = new Set(['command', 'test', 'file-contains', 'file-exists']);

export const ACCEPTANCE_CLOSE_GATE_CODE = 'acceptance_evidence_incomplete';

export type AcceptanceCloseGapReason = 'missing' | 'failed' | 'unresolved';

export interface AcceptanceCloseGap {
  readonly criterionId: string;
  readonly description: string;
  readonly reason: AcceptanceCloseGapReason;
}

export interface AcceptanceCloseVerdict {
  readonly ok: boolean;
  readonly gaps: readonly AcceptanceCloseGap[];
  readonly message: string;
}

export interface AcceptanceCloseTaskLike {
  readonly evidenceRefs?: readonly string[] | null;
  readonly subtasks?: readonly AcceptanceCloseTaskLike[] | null;
}

export interface AcceptanceClosePlanLike {
  readonly successCriteria?: readonly GoalSuccessCriterion[] | null;
  readonly criterionResults?: readonly GoalCriterionResult[] | null;
  readonly manualConfirmations?: readonly GoalManualConfirmation[] | null;
  readonly evidenceRefs?: readonly string[] | null;
  readonly tasks?: readonly AcceptanceCloseTaskLike[] | null;
  readonly runTrace?: {
    readonly events?: readonly { readonly evidenceRefs?: readonly string[] | null }[] | null;
  } | null;
}

export class AcceptanceCloseGateError extends Error {
  readonly code = ACCEPTANCE_CLOSE_GATE_CODE;
  readonly gaps: readonly AcceptanceCloseGap[];

  constructor(message: string, gaps: readonly AcceptanceCloseGap[] = []) {
    super(message);
    this.name = 'AcceptanceCloseGateError';
    this.gaps = gaps;
  }
}

function trimRef(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function walkTaskRefs(tasks: readonly AcceptanceCloseTaskLike[] | null | undefined, into: Set<string>): void {
  for (const task of tasks ?? []) {
    for (const ref of task.evidenceRefs ?? []) {
      const held = trimRef(ref);
      if (held) into.add(held);
    }
    walkTaskRefs(task.subtasks, into);
  }
}

/** 计划上已经持有的证据引用。不算 criterionResults 里的自称。 */
export function collectHeldEvidenceRefs(plan: AcceptanceClosePlanLike | null | undefined): readonly string[] {
  const refs = new Set<string>();
  for (const ref of plan?.evidenceRefs ?? []) {
    const held = trimRef(ref);
    if (held) refs.add(held);
  }
  walkTaskRefs(plan?.tasks, refs);
  for (const event of plan?.runTrace?.events ?? []) {
    for (const ref of event.evidenceRefs ?? []) {
      const held = trimRef(ref);
      if (held) refs.add(held);
    }
  }
  return [...refs];
}

function latestManualApproval(plan: AcceptanceClosePlanLike, criterionId: string): boolean {
  const matches = (plan.manualConfirmations ?? [])
    .filter((confirmation) => confirmation.kind === 'manual_dod')
    .filter((confirmation) => confirmation.criterionIds.includes(criterionId))
    .slice()
    .sort((left, right) => String(right.decidedAt || '').localeCompare(String(left.decidedAt || '')));
  return matches[0]?.decision === 'approve';
}

function gapMessage(gaps: readonly AcceptanceCloseGap[], locale: 'zh' | 'en'): string {
  if (gaps.length === 0) return '';
  if (locale === 'en') {
    return gaps.length === 1
      ? `Cannot accept yet: ${gaps[0].description} still lacks resolvable evidence.`
      : `Cannot accept yet: ${gaps.length} success criteria still lack resolvable evidence.`;
  }
  return gaps.length === 1
    ? `还不能验收：${gaps[0].description} 还缺可解析的对照证据。`
    : `还不能验收：还有 ${gaps.length} 条成功标准缺少可解析的对照证据。`;
}

export function evaluateAcceptanceCloseGate(
  plan: AcceptanceClosePlanLike | null | undefined,
  options: {
    readonly knownRefs?: readonly string[] | null;
    readonly locale?: 'zh' | 'en';
  } = {},
): AcceptanceCloseVerdict {
  const locale = options.locale === 'en' ? 'en' : 'zh';
  const criteria = plan?.successCriteria ?? [];
  if (criteria.length === 0) {
    return { ok: true, gaps: [], message: '' };
  }

  const known = new Set(
    (options.knownRefs ?? collectHeldEvidenceRefs(plan))
      .map((ref) => trimRef(ref))
      .filter((ref): ref is string => Boolean(ref)),
  );
  const results = new Map(
    (plan?.criterionResults ?? [])
      .filter((result) => result?.criterionId)
      .map((result) => [result.criterionId, result] as const),
  );
  const gaps: AcceptanceCloseGap[] = [];

  for (const criterion of criteria) {
    const id = criterion.id?.trim();
    if (!id) continue;
    const description = criterion.description?.trim() || id;
    const isAuto = AUTO_CRITERION_KINDS.has(criterion.kind);
    const result = results.get(id) ?? null;

    if (!isAuto && latestManualApproval(plan ?? {}, id)) continue;

    if (!result) {
      gaps.push({ criterionId: id, description, reason: 'missing' });
      continue;
    }
    if (!result.passed) {
      gaps.push({ criterionId: id, description, reason: 'failed' });
      continue;
    }
    const evidenceRef = trimRef(result.evidenceRef);
    if (!evidenceRef || !known.has(evidenceRef)) {
      gaps.push({ criterionId: id, description, reason: 'unresolved' });
    }
  }

  return {
    ok: gaps.length === 0,
    gaps,
    message: gapMessage(gaps, locale),
  };
}

export function assertAcceptanceCloseGate(
  plan: AcceptanceClosePlanLike | null | undefined,
  options: {
    readonly knownRefs?: readonly string[] | null;
    readonly locale?: 'zh' | 'en';
  } = {},
): void {
  const verdict = evaluateAcceptanceCloseGate(plan, options);
  if (!verdict.ok) {
    throw new AcceptanceCloseGateError(verdict.message, verdict.gaps);
  }
}

export function isAcceptanceClosePatch(
  previous: { readonly acceptedAt?: string | null } | null | undefined,
  next: { readonly acceptedAt?: string | null } | null | undefined,
): boolean {
  const prevAt = typeof previous?.acceptedAt === 'string' ? previous.acceptedAt.trim() : '';
  const nextAt = typeof next?.acceptedAt === 'string' ? next.acceptedAt.trim() : '';
  return nextAt.length > 0 && nextAt !== prevAt;
}
