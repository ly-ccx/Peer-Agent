import { normalizeResourceEditOperation, resourceEditDigest, resourceEditToken,
  type ResourceEditOperation, type ResourceEditOperationStatus } from '@peer-agent/protocol';
import type { ResourceEditSessionState } from './resourceEditSession.ts';
export const sameEditHandle = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function submissionOperation(raw: unknown, draft: ResourceEditSessionState, workspaceId: string, draftId: string): ResourceEditOperation | null {
  const op = normalizeResourceEditOperation(raw), target = draft.baseline?.target;
  return op && target && op.draftId === draftId && op.target.recipient.workspaceId === workspaceId && JSON.stringify(op.target) === JSON.stringify(target) ? op : null;
}
export function submissionStatus(raw: ResourceEditOperationStatus, draft: ResourceEditSessionState, workspaceId: string, draftId: string, requestId: string): ResourceEditOperationStatus | null {
  const operation = submissionOperation(raw?.operation, draft, workspaceId, draftId);
  if (!operation || operation.requestId !== requestId || typeof raw.live !== 'boolean' || typeof raw.hasActualResult !== 'boolean'
    || !['pending', 'recorded', 'unconfirmed', 'unavailable'].includes(raw.governance)
    || raw.hostOwnedHere !== undefined && typeof raw.hostOwnedHere !== 'boolean'
    || raw.permissionElsewhere !== undefined && typeof raw.permissionElsewhere !== 'boolean'
    || raw.permissionElsewhere && (!!raw.permission || operation.phase !== 'running' || !raw.live)
    || raw.observation !== undefined && !['matches_base', 'matches_proposed', 'changed', 'unavailable'].includes(raw.observation)) return null;
  const permission = raw.permission;
  if (permission && (operation.phase !== 'running' || !raw.live || permission.requestId !== requestId || !resourceEditToken(permission.challengeId) || !resourceEditDigest(permission.argsDigest)
    || !Number.isFinite(Date.parse(permission.deadlineAt)) || permission.path !== operation.target.reference.path || permission.expectedVersion !== operation.target.base.contentVersion
    || permission.proposedVersion !== operation.proposedVersion || typeof permission.reason !== 'string' || permission.reason.length > 2048
    || permission.confirmation !== undefined && (typeof permission.confirmation !== 'string' || permission.confirmation.length > 2048))) return null;
  if (permission !== null && !permission) return null;
  return { operation, live: raw.live, hasActualResult: raw.hasActualResult, governance: raw.governance, permission,
    ...(raw.hostOwnedHere !== undefined ? { hostOwnedHere: raw.hostOwnedHere } : {}), ...(raw.permissionElsewhere !== undefined ? { permissionElsewhere: raw.permissionElsewhere } : {}), ...(raw.observation ? { observation: raw.observation } : {}) };
}
export function needsSubmissionBase(operations: readonly ResourceEditOperation[], draft: ResourceEditSessionState): boolean {
  const base = draft.baseline?.target.base.contentVersion;
  return !!base && operations.some(op => op.phase === 'settled' && op.receipt?.outcome === 'applied' && op.target.base.contentVersion === base && op.receipt.observedVersion !== base);
}
export function submissionReadiness(draft: ResourceEditSessionState, operations: readonly ResourceEditOperation[], ready: boolean, unconfirmed: boolean, blockers = 0, observation?: ResourceEditOperationStatus['observation']): string | null {
  if (!ready) return 'RESOURCE_EDIT_SUBMISSION_LOADING';
  if (unconfirmed) return 'RESOURCE_EDIT_SUBMIT_UNCONFIRMED';
  if (blockers || operations.some(op => op.phase !== 'settled')) return 'RESOURCE_EDIT_OPERATION_PENDING';
  if (!draft.view || !draft.writer) return 'RESOURCE_EDIT_STALE_WRITER';
  if (draft.composing) return 'RESOURCE_EDIT_COMPOSITION_ACTIVE';
  if (draft.reviewRequired || draft.remoteChanged) return 'RESOURCE_EDIT_LOCAL_CONFLICT';
  if (draft.loading || draft.saving) return 'RESOURCE_EDIT_SAVE_PENDING';
  if (needsSubmissionBase(operations, draft) && observation !== 'matches_base') return 'RESOURCE_EDIT_NEW_BASE_REQUIRED';
  if (draft.text === draft.baseline?.baseText) return 'RESOURCE_EDIT_NO_CHANGES';
  return null;
}
