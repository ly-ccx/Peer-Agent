import type { GoalPlan, GoalRunEvent } from './goal.ts';
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

const TOOL_EVENT_TYPES = new Set<GoalRunEvent['type']>([
  'action_started',
  'action_completed',
  'step_started',
  'step_completed',
]);

const DENIAL_EVENT_TYPES = new Set<GoalRunEvent['type']>([
  'validation_failed',
  'problem_found',
]);

const MAX_BASIS_EVENTS = 20;

function trimText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function eventTitle(type: GoalRunEvent['type'], isZh: boolean): string {
  const zh: Partial<Record<GoalRunEvent['type'], string>> = {
    action_started: '开始执行',
    action_completed: '执行完成',
    step_started: '开始一步',
    step_completed: '完成一步',
    validation_failed: '检查没通过',
    problem_found: '发现问题',
  };
  const en: Partial<Record<GoalRunEvent['type'], string>> = {
    action_started: 'Action started',
    action_completed: 'Action completed',
    step_started: 'Step started',
    step_completed: 'Step completed',
    validation_failed: 'Validation failed',
    problem_found: 'Problem found',
  };
  return (isZh ? zh[type] : en[type]) ?? type;
}

/** 验收页可读依据：授权、工具、产物、拒绝。不摊整段 runTrace。 */
export function projectAcceptanceBasis(
  plan: GoalPlan | null | undefined,
  options: { readonly isZh?: boolean } = {},
): AcceptanceBasisProjection {
  const isZh = options.isZh !== false;
  const events: AcceptanceBasisEvent[] = [];
  const approval = plan?.approval;
  const approved = approval?.decision === 'approve';
  const approvedAt = trimText(approval?.decidedAt) ?? undefined;

  if (approved || approval?.decision === 'reject') {
    events.push({
      id: `grant:${plan?.planId ?? 'plan'}`,
      kind: 'grant',
      at: approvedAt,
      title: approved
        ? (isZh ? '计划已批准' : 'Plan approved')
        : (isZh ? '计划被驳回' : 'Plan rejected'),
      detail: trimText(approval?.feedback) ?? undefined,
    });
  }

  for (const event of plan?.runTrace?.events ?? []) {
    const kind = TOOL_EVENT_TYPES.has(event.type)
      ? 'tool'
      : DENIAL_EVENT_TYPES.has(event.type)
        ? 'denial'
        : null;
    if (!kind) continue;
    events.push({
      id: event.id || `${event.type}:${event.createdAt}`,
      kind,
      at: trimText(event.createdAt) ?? undefined,
      title: eventTitle(event.type, isZh),
      detail: trimText(event.summary) ?? undefined,
    });
  }

  const artifactRefs = [...collectHeldEvidenceRefs(plan)];
  for (const result of plan?.criterionResults ?? []) {
    const ref = trimText(result.evidenceRef);
    if (ref && !artifactRefs.includes(ref)) artifactRefs.push(ref);
  }
  for (const [index, ref] of artifactRefs.entries()) {
    events.push({
      id: `artifact:${ref}`,
      kind: 'artifact',
      title: isZh ? '留下产物' : 'Artifact kept',
      detail: ref.split('/').filter(Boolean).slice(-2).join(' / ') || ref,
      at: plan?.updatedAt,
    });
    if (index >= 7) break;
  }

  events.sort((left, right) => String(left.at ?? '').localeCompare(String(right.at ?? '')));
  const clipped = events.length > MAX_BASIS_EVENTS
    ? events.slice(events.length - MAX_BASIS_EVENTS)
    : events;

  return {
    events: clipped,
    authorization: {
      planApproved: approved,
      approvedAt,
      toolCount: events.filter((event) => event.kind === 'tool').length,
      artifactCount: artifactRefs.length,
      denialCount: events.filter((event) => event.kind === 'denial').length,
    },
  };
}

export function formatAuthorizationSummary(
  summary: AuthorizationSummary,
  isZh = true,
): string {
  const bits: string[] = [];
  if (summary.planApproved) bits.push(isZh ? '计划已批准' : 'Plan approved');
  bits.push(isZh ? `工具 ${summary.toolCount}` : `tools ${summary.toolCount}`);
  bits.push(isZh ? `产物 ${summary.artifactCount}` : `artifacts ${summary.artifactCount}`);
  if (summary.denialCount > 0) {
    bits.push(isZh ? `拒绝 ${summary.denialCount}` : `denied ${summary.denialCount}`);
  }
  return bits.join(' · ');
}
