import { interactiveToken, normalizeInteractiveOwner, normalizeInteractiveReference } from '@peer-agent/protocol';
import { interactiveExecutionRole, interactiveCapabilitiesForProfile } from './role-policy.mjs';
export { interactiveExecutionRole, interactiveCapabilitiesForProfile } from './role-policy.mjs';
import { executionIdentity, sameExecution } from '../project-agent/session-control-kernel.mjs';
import { sessionExecutionCurrent } from '../project-agent/execution-ownership.mjs';
import { encode, problem } from './storage.mjs';

const same = (a, b) => encode(a) === encode(b);
function requireTrue(value, code = 'interactive_scope_denied') { if (value !== true) throw problem(code); }

/** Reconstruct authority from current canonical host facts, never tool arguments or assistant prose. */
export function createInteractiveAuthority({ goalPlanStore, conversationStore, resultStore, getBotConversationId,
  holdsLease, enabled, classifyContext }) {
  function resolve({ call, toolContext = {} }) {
    const profile = toolContext.turnProfile, role = interactiveExecutionRole(profile);
    if (!role || !interactiveToken(toolContext.conversationId) || typeof holdsLease !== 'function' || typeof enabled !== 'function') throw problem('interactive_authority_unavailable');
    const plan = profile.planId ? goalPlanStore.getPlan(profile.planId) : null;
    const workspaceId = role === 'project_agent' ? profile.workspaceId : plan?.delegationOrigin?.workspaceId;
    const owner = normalizeInteractiveOwner({ workspaceId, conversationId: getBotConversationId?.(workspaceId) });
    if (!owner || toolContext.workspaceId && toolContext.workspaceId !== workspaceId || profile.workspaceId !== workspaceId) throw problem('interactive_scope_denied');
    const access = toolContext.resolveAccessPolicy?.();
    if (access && (!access.ok || access.policy?.workspaceId !== owner.workspaceId || access.policy?.conversationId !== owner.conversationId
      || !Number.isSafeInteger(access.policy?.revision))) throw problem('interactive_policy_unavailable');
    const expectedPolicyRevision = access?.policy?.revision;
    const policyRevision = access?.policy ? `bot:${owner.workspaceId}:${owner.conversationId}:${expectedPolicyRevision}` : undefined;
    const expectedExecution = plan?.delegationOrigin ? executionIdentity(plan) : null;
    function current() {
      if (enabled(workspaceId) !== true || holdsLease(workspaceId) !== true || getBotConversationId(workspaceId) !== owner.conversationId
        || interactiveExecutionRole(profile) !== role || profile.workspaceId !== owner.workspaceId) return false;
      if (policyRevision) {
        const freshAccess = toolContext.resolveAccessPolicy();
        if (!freshAccess?.ok || freshAccess.policy?.workspaceId !== owner.workspaceId || freshAccess.policy?.conversationId !== owner.conversationId
          || freshAccess.policy?.revision !== expectedPolicyRevision) return false;
      }
      if (role === 'project_agent') return toolContext.conversationId === owner.conversationId;
      const fresh = goalPlanStore.getPlan(profile.planId), origin = fresh?.delegationOrigin;
      return !!origin && origin.workspaceId === owner.workspaceId && origin.parentConversationId === owner.conversationId
        && fresh.conversationId === toolContext.conversationId && profile.sessionId === origin.sessionId
        && sameExecution(profile.executionIdentity, executionIdentity(fresh)) && sameExecution(expectedExecution, executionIdentity(fresh))
        && sessionExecutionCurrent(fresh);
    }
    requireTrue(current(), 'interactive_execution_stale');
    const dataLevel = classifyContext?.({ owner, plan, toolContext });
    const admittedVersions = new Map();
    const history = () => conversationStore?.getPersistedConversationHistory?.(toolContext.conversationId)?.messages ?? [];
    function frozenFeedback() {
      return history().filter(message => message.role === 'user').flatMap(message => message.resourceFeedback ?? [])
        .filter(feedback => normalizeInteractiveOwner(feedback?.recipient) && same(feedback.recipient, owner) && feedback.resource?.kind === 'interactive'
          && normalizeInteractiveReference(feedback.resource.reference));
    }
    function fixedOrigin(reference, { allowPending = false } = {}) {
      try {
        const fixed = resultStore.getVersion(reference, { allowPending });
        const sourcePlan = goalPlanStore.getPlan(fixed.source.planId), origin = sourcePlan?.delegationOrigin;
        if (!origin || origin.workspaceId !== owner.workspaceId || origin.parentConversationId !== owner.conversationId
          || sourcePlan.conversationId !== fixed.source.conversationId || origin.sessionId !== fixed.source.sessionId) return null;
        return fixed;
      } catch { return null; }
    }
    function admitResult(raw) {
      const reference = normalizeInteractiveReference(raw);
      if (!reference || !same(reference.owner, owner)) return false;
      const fixed = fixedOrigin(reference);
      if (!fixed) return false;
      const allowed = role === 'project_agent' || fixed.source.planId === plan.planId && sameExecution(fixed.source, expectedExecution)
        || frozenFeedback().some(feedback => same(feedback.resource.reference, reference));
      if (allowed) admittedVersions.set(encode(reference), fixed);
      return allowed;
    }
    function admitPublication(reference) {
      if (!same(reference.owner, owner)) return false;
      const saved = resultStore.getOperation(reference);
      if (!saved) {
        const attempt = resultStore.getAttempt?.(reference), origin = attempt && goalPlanStore.getPlan(attempt.source.planId)?.delegationOrigin;
        return !!origin && origin.workspaceId === owner.workspaceId && origin.parentConversationId === owner.conversationId
          && (role === 'project_agent' || reference.conversationId === toolContext.conversationId);
      }
      if (!saved || !fixedOrigin(saved.reference, { allowPending: true })) return false;
      return role === 'project_agent' || reference.conversationId === toolContext.conversationId;
    }
    function admitMaterial(source, selector) {
      if (role !== 'session_worker' && !['verifier', 'visual_verifier'].includes(role)) return false;
      if (source.kind === 'tool-result' && source.conversationId === toolContext.conversationId) return true;
      if (source.kind === 'user-material' && history().some(message => message.id === source.messageId && message.role === 'user'
        && message.attachments?.some(item => item.id === source.attachmentId && item.sourceKind === 'user_upload'))) return true;
      // A carried fixed result admits only its already selected snapshot range,
      // never the rest of the original tool observation or another work's files.
      for (const feedback of frozenFeedback()) admitResult(feedback.resource.reference);
      return [...admittedVersions.values()].some(fixed => (fixed.provenance ?? []).some(record =>
        same(record.source, source) && same(record.selector ?? {}, selector ?? {})));
    }
    return { owner, role, dataLevel, capabilityIds: interactiveCapabilitiesForProfile(profile), assertCurrent: current,
      ...(policyRevision ? { policyRevision } : {}),
      ...(plan ? { source: { ...expectedExecution, conversationId: plan.conversationId, toolCallId: call.toolCallId,
        ...(profile.workId ? { workId: profile.workId } : {}) } } : {}),
      ...(toolContext.streamId ? { streamId: toolContext.streamId } : {}),
      admitResult, admitPublication, admitMaterial,
      admitFollowup: id => frozenFeedback().some(feedback => feedback.version?.kind === 'interactive' && feedback.version.followupId === id) };
  }
  return { resolve };
}
