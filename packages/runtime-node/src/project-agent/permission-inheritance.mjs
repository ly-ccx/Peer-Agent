import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { digestApprovalArgs } from './permission-operation.mjs';

export const IMAGE_READ_GRANT_TTL_MS = 30 * 60 * 1000;
const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const stopped = plan => ['cancelled', 'paused', 'interrupted'].includes(plan?.status)
  || ['cancelled', 'paused', 'superseded'].includes(plan?.delegationOrigin?.phase)
  || plan?.delegationOrigin?.supersededBy || plan?.delegationOrigin?.cancellation;

/** Host facts only. A profile's claimed parent is never an authority source.
 * @param {{workspaceId?: string | null, conversationId?: string | null, planId?: string | null, sessionId?: string | null, goalPlanStore?: any}} [input]
 * @returns {{workspaceId: string | null, conversationId: string, policyRevision?: string} | null}
 */
export function resolvePermissionPrincipal({ workspaceId, conversationId, planId, sessionId, goalPlanStore } = {}) {
  workspaceId = text(workspaceId); conversationId = text(conversationId);
  if (!planId) return conversationId ? { workspaceId, conversationId } : null;
  const plan = goalPlanStore?.getPlan?.(planId);
  const origin = plan?.delegationOrigin;
  // Ordinary Goals keep their host-bound conversation; they cannot claim a parent.
  if (plan && !origin && !stopped(plan)) {
    return workspaceId && conversationId && conversationId === plan.conversationId
      ? { workspaceId, conversationId } : null;
  }
  if (!plan || stopped(plan) || !workspaceId || origin?.workspaceId !== workspaceId
    || !sessionId || origin.sessionId !== sessionId
    || conversationId && conversationId !== plan.conversationId) return null;
  let parent = text(origin.parentConversationId);
  // Deeper workers inherit only through an intact, host-owned ancestor chain.
  for (let depth = 0; parent && depth < 4; depth++) {
    const ancestor = goalPlanStore?.getActivePlanByConversation?.(parent);
    if (!ancestor?.delegationOrigin) return { workspaceId, conversationId: parent };
    if (stopped(ancestor) || ancestor.delegationOrigin.workspaceId !== workspaceId) return null;
    parent = text(ancestor.delegationOrigin.parentConversationId);
  }
  return null;
}

/** Exact operation grants, never executable-name or capability-only grants.
 * @param {{capabilityId: string, args: unknown, conversationId?: string | null, workspacePath?: string | null, sessionId?: string | null, planId?: string | null}} input
 */
export function permissionOperationKey({ capabilityId, args, conversationId, workspacePath, sessionId, planId }) {
  return digestApprovalArgs({ capabilityId, args, conversationId: conversationId ?? null,
    workspacePath: workspacePath ?? null, sessionId: sessionId ?? null, planId: planId ?? null });
}

export function normalizeImageReadGrant(value) {
  if (!value || value.schemaVersion !== 1 || !text(value.grantId) || !text(value.conversationId)
    || !Number.isFinite(value.expiresAt) || value.scope?.capabilityId !== 'local.image.read'
    || value.scope.action !== 'read_image_for_model' || !isAbsolute(value.scope.path ?? '')) return null;
  const identity = value.scope.fileIdentity;
  if (!identity || !['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => Number.isFinite(identity[key]))) return null;
  return { schemaVersion: 1, grantId: value.grantId, workspaceId: text(value.workspaceId),
    ...(text(value.policyRevision) ? { policyRevision: value.policyRevision } : {}),
    conversationId: value.conversationId, expiresAt: value.expiresAt,
    scope: { capabilityId: 'local.image.read', action: 'read_image_for_model', path: value.scope.path,
      workspacePath: text(value.scope.workspacePath), fileIdentity: {
        dev: identity.dev, ino: identity.ino, size: identity.size, mtimeMs: identity.mtimeMs, ctimeMs: identity.ctimeMs,
      } } };
}

function sameImage(left, right) {
  return left?.capabilityId === 'local.image.read' && right?.capabilityId === 'local.image.read'
    && left.action === right.action && left.path === right.path
    && digestApprovalArgs(left.fileIdentity) === digestApprovalArgs(right.fileIdentity);
}

/** Durable, exact-image authority; record history alone is not a grant.
 * @param {{approvalStore?: any, now?: () => number}} [options]
 */
export function createImageReadAuthority({ approvalStore, now = () => Date.now() } = {}) {
  function match({ principal, scope, toolCallId }) {
    if (!principal || !normalizeImageReadGrant({ schemaVersion: 1, grantId: 'check', ...principal,
      scope, expiresAt: Number(now()) + 1 })) return null;
    const records = approvalStore?.list?.({ workspaceId: principal.workspaceId ?? null }) ?? [];
    for (const record of records) {
      const grant = normalizeImageReadGrant(record.imageReadGrant);
      if (record.state !== 'approved' || record.decidedBy !== 'local_ui' || record.capabilityId !== 'local.image.read'
        || !grant || grant.expiresAt <= Number(now()) || grant.workspaceId !== principal.workspaceId
        || grant.conversationId !== principal.conversationId || !sameImage(grant.scope, scope)
        || (grant.policyRevision ?? null) !== (principal.policyRevision ?? null)
          && !(grant.policyRevision == null && principal.policyRevision?.startsWith('bot:') && principal.policyRevision.endsWith(':1'))) continue;
      return { granted: true, reason: 'local_user_approved_image_scope', grant: {
        grantId: grant.grantId, toolCallId, granted: true, duration: 'scope', scope,
        decidedAt: record.decidedAt, expiresAt: grant.expiresAt,
      } };
    }
    return null;
  }
  function remember({ principal, scope, record }) {
    if (!principal || record?.decidedBy !== 'local_ui' || record?.state !== 'approved') return null;
    const existing = match({ principal, scope, toolCallId: record.approvalId });
    if (existing) return normalizeImageReadGrant({ schemaVersion: 1, ...principal, scope,
      grantId: existing.grant.grantId, expiresAt: existing.grant.expiresAt });
    const imageReadGrant = normalizeImageReadGrant({ schemaVersion: 1, grantId: `image-${randomUUID()}`,
      ...principal, scope, expiresAt: Number(now()) + IMAGE_READ_GRANT_TTL_MS });
    if (!imageReadGrant) return null;
    // Distinct ID avoids changing an already-appended approval with the same state.
    const saved = approvalStore?.append?.({ ...record, approvalId: imageReadGrant.grantId,
      kind: 'image_read_grant', imageReadGrant });
    return saved?.imageReadGrant ? imageReadGrant : null;
  }
  /** @param {{shouldRevoke?: (grant: any) => boolean}} [options] */
  function revokeAll({ shouldRevoke = () => true } = {}) {
    for (const record of approvalStore?.list?.({ state: 'approved' }) ?? []) {
      if (record.imageReadGrant && shouldRevoke(record.imageReadGrant)) approvalStore.append({ ...record, state: 'expired',
        decidedAt: new Date(Number(now())).toISOString(), decidedBy: 'policy' });
    }
  }
  return { match, remember, revokeAll };
}
