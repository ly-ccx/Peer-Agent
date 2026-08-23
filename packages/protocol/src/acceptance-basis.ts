import type { GoalPlan } from './goal.ts';
import { collectHeldEvidenceRefs } from './acceptance-close-gate.ts';

export type AcceptanceBasisKind = 'grant' | 'tool' | 'artifact' | 'denial';

export interface AcceptanceBasisEvent {
  readonly id: string;
  readonly kind: AcceptanceBasisKind;
  readonly at?: string;
  readonly title: string;
  readonly detail?: string;
}

export interface AuthorizationSummary {
  readonly planApproved: boolean;
  readonly approvedAt?: string;
  readonly toolCount: number;
  readonly artifactCount: number;
  readonly denialCount: number;
}

export interface AcceptanceBasisProjection {
  readonly events: readonly AcceptanceBasisEvent[];
  readonly authorization: AuthorizationSummary;
}

function trimText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/**
 * 导出用授权摘要：计划是否已批准、持有多少已承认产物。
 * 不投影 runTrace，验收页也不再消费这段时间线。
 */
export function projectAcceptanceBasis(
  plan: GoalPlan | null | undefined,
): AcceptanceBasisProjection {
  const approval = plan?.approval;
  const approved = approval?.decision === 'approve';
  const approvedAt = trimText(approval?.decidedAt) ?? undefined;
  const artifactCount = collectHeldEvidenceRefs(plan).length;

  return {
    events: [],
    authorization: {
      planApproved: approved,
      approvedAt,
      toolCount: 0,
      artifactCount,
      denialCount: 0,
    },
  };
}

export function formatAuthorizationSummary(
  summary: AuthorizationSummary,
  isZh = true,
): string {
  const bits: string[] = [];
  if (summary.planApproved) bits.push(isZh ? '计划已批准' : 'Plan approved');
  if (summary.artifactCount > 0) {
    bits.push(isZh ? `${summary.artifactCount} 份产物` : `${summary.artifactCount} artifacts`);
  }
  return bits.join(' · ');
}
