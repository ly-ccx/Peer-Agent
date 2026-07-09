import type {
  EvidenceRef,
  PermissionDecision,
  PermissionGrant,
  PermissionRequest,
  RuntimeDecision,
  RuntimeJsonObject,
} from './contracts.ts';
import { mostRestrictiveDecision } from './decision.ts';

export type PermissionDecisionLike = RuntimeDecision | PermissionDecision | null | undefined;

export interface MergePermissionDecisionsOptions {
  readonly defaultSource?: string;
  readonly defaultReason?: string;
}

export interface CreatePermissionGrantDraftOptions {
  readonly grantId: string;
  readonly grantedAt: string;
  readonly evidenceRefs?: readonly EvidenceRef[];
  readonly metadata?: RuntimeJsonObject;
}

function decisionValue(decision: PermissionDecisionLike): RuntimeDecision | undefined {
  if (!decision) {
    return undefined;
  }
  if (typeof decision === 'string') {
    return decision;
  }
  return decision.decision;
}

export function mostRestrictivePermissionDecision(
  decisions: readonly PermissionDecisionLike[] = [],
): RuntimeDecision {
  return mostRestrictiveDecision(decisions.map(decisionValue));
}

export function mergePermissionDecisions(
  decisions: readonly (PermissionDecision | null | undefined)[] = [],
  options: MergePermissionDecisionsOptions = {},
): PermissionDecision {
  const validDecisions = decisions.filter((decision): decision is PermissionDecision => Boolean(decision));
  const finalDecision = mostRestrictivePermissionDecision(validDecisions);
  const sourceDecision = validDecisions.find((decision) => decision.decision === finalDecision);

  const reason = sourceDecision?.reason ?? options.defaultReason;
  const metadata = sourceDecision?.metadata;

  return {
    decision: finalDecision,
    source: sourceDecision?.source ?? options.defaultSource ?? 'runtime_core_default',
    ...(reason !== undefined ? { reason } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

export function isPermissionAllowed(decision: PermissionDecisionLike): boolean {
  return decisionValue(decision) === 'allow';
}

export function isPermissionAsking(decision: PermissionDecisionLike): boolean {
  return decisionValue(decision) === 'ask';
}

export function isPermissionDenied(decision: PermissionDecisionLike): boolean {
  return decisionValue(decision) === 'deny';
}

export function createPermissionGrantDraft(
  decision: PermissionDecision,
  request: Pick<PermissionRequest, 'capabilityId'>,
  options: CreatePermissionGrantDraftOptions,
): PermissionGrant {
  return {
    grantId: options.grantId,
    capabilityId: request.capabilityId,
    decision: decision.decision,
    grantedAt: options.grantedAt,
    source: decision.source,
    reason: decision.reason,
    evidenceRefs: options.evidenceRefs,
    metadata: {
      ...decision.metadata,
      ...options.metadata,
    },
  };
}
