import { interactiveToken, normalizeInteractiveOwner, normalizeInteractiveReference, restoreResourceFeedbackTransport } from '@peer-agent/protocol';
import { interactiveExecutionRole, interactiveCapabilitiesForProfile } from './role-policy.mjs';
export { interactiveExecutionRole, interactiveCapabilitiesForProfile } from './role-policy.mjs';
import { executionIdentity, sameExecution } from '../project-agent/session-control-kernel.mjs';
import { sessionExecutionCurrent } from '../project-agent/execution-ownership.mjs';
import { encode, problem } from './storage.mjs';

const same = (a, b) => encode(a) === encode(b);
function requireTrue(value, code = 'interactive_scope_denied') { if (value !== true) throw problem(code); }

/** Reconstruct authority from current canonical host facts, never tool arguments or assistant prose. */
export function createInteractiveAuthority({ goalPlanStore, conversationStore, resultStore, getBotConversationId,
  holdsLease, enabled, classifyContext, readResourceFeedback, resolveVerification }) {
  function resolve({ call, toolContext = {} }) {
    const profile = toolContext.turnProfile, role = interactiveExecutionRole(profile);
    const verifying = ['verifier', 'visual_verifier'].includes(role);
    const verification = verifying ? resolveVerification?.(profile) : null;
    if (verifying && !verification) throw problem('interactive_verification_binding_required');
    const conversationId = verifying && toolContext.conversationId == null ? verification.conversationId : toolContext.conversationId;
    if (!role || !interactiveToken(conversationId) || typeof holdsLease !== 'function' || typeof enabled !== 'function') throw problem('interactive_authority_unavailable');
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
      if (verifying) { try { if (!same(verification.owner, owner) || verification.assertCurrent() !== true) return false; } catch { return false; } }
      const fresh = goalPlanStore.getPlan(profile.planId), origin = fresh?.delegationOrigin;
      return !!origin && origin.workspaceId === owner.workspaceId && origin.parentConversationId === owner.conversationId
        && fresh.conversationId === conversationId && profile.sessionId === origin.sessionId
        && sameExecution(profile.executionIdentity, executionIdentity(fresh)) && sameExecution(expectedExecution, executionIdentity(fresh))
        && sessionExecutionCurrent(fresh);
    }
    requireTrue(current(), 'interactive_execution_stale');
    const dataLevel = classifyContext?.({ owner, plan, toolContext });
    function currentDataLevel() {
      const minimum = classifyContext?.({ owner, plan: profile.planId ? goalPlanStore.getPlan(profile.planId) : undefined, toolContext });
      return resultStore.ownerDataLevel ? resultStore.ownerDataLevel(owner, minimum) : minimum;
    }
    const admittedVersions = new Map();
    const history = () => conversationStore?.getPersistedConversationHistory?.(conversationId)?.messages ?? [];
    function frozenFeedback() {
      return history().filter(message => message.role === 'user').flatMap(message => {
        const rows = restoreResourceFeedbackTransport(message.resourceFeedback, message.attachments);
        if (!rows.some(row => row.resource.kind === 'interactive')) return [];
        if (typeof readResourceFeedback !== 'function') throw problem('INTERACTIVE_FEEDBACK_UNAVAILABLE');
        const actual = readResourceFeedback(message, owner.workspaceId);
        if (!same(rows, actual)) throw problem('INTERACTIVE_FEEDBACK_MISMATCH');
        return actual.filter(feedback => same(feedback.recipient, owner) && feedback.resource.kind === 'interactive');
      });
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
      const allowed = verifying ? verification.admitResult(reference) : role === 'project_agent' || fixed.source.planId === plan.planId && sameExecution(fixed.source, expectedExecution)
        || frozenFeedback().some(feedback => same(feedback.resource.reference, reference));
      if (allowed) admittedVersions.set(encode(reference), fixed);
      return allowed;
    }
    function admitPublication(reference) {
      if (verifying) return false;
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
      if (role !== 'session_worker') return false;
      if (source.kind === 'tool-result' && source.conversationId === conversationId) return true;
      if (source.kind === 'user-material' && history().some(message => message.id === source.messageId && message.role === 'user'
        && message.attachments?.some(item => item.id === source.attachmentId && item.sourceKind === 'user_upload'))) return true;
      // A carried fixed result admits only its already selected snapshot range,
      // never the rest of the original tool observation or another work's files.
      for (const feedback of frozenFeedback()) admitResult(feedback.resource.reference);
      return [...admittedVersions.values()].some(fixed => (fixed.provenance ?? []).some(record =>
        same(record.source, source) && same(record.selector ?? {}, selector ?? {})));
    }
    return { owner, role, dataLevel, currentDataLevel, capabilityIds: interactiveCapabilitiesForProfile(profile), assertCurrent: current,
      ...(policyRevision ? { policyRevision } : {}),
      ...(verifying ? { inspectionReview: verification.review } : {}),
      ...(plan ? { source: { ...expectedExecution, conversationId: plan.conversationId,
        ...(interactiveToken(call?.toolCallId) ? { toolCallId: call.toolCallId } : {}),
        ...(profile.workId ? { workId: profile.workId } : {}) } } : {}),
      ...(toolContext.streamId ? { streamId: toolContext.streamId } : {}),
      admitResult, admitPublication, admitMaterial,
      admitFollowup: id => verifying ? verification.admitFollowup(id)
        : frozenFeedback().some(feedback => feedback.version?.kind === 'interactive' && feedback.version.followupId === id) };
  }
  function resolveObservation({ toolContext = {} }) {
    const profile = toolContext.turnProfile;
    if (!profile || profile.role !== 'project_agent' && !(profile.role === 'work_session'
      && ['worker', 'explorer', 'verifier', 'visual_verifier'].includes(profile.agentKind))) throw problem('interactive_scope_denied');
    const plan = profile.planId ? goalPlanStore.getPlan(profile.planId) : null;
    // Ephemeral verifier results still affect the owner's conservative privacy
    // floor. Their actual host execution identity binds the absent conversation;
    // this observation path never admits result bodies or resumes execution.
    const ephemeralVerifier = toolContext.conversationId == null && profile.role === 'work_session'
      && ['verifier', 'visual_verifier'].includes(profile.agentKind) && !!plan?.delegationOrigin
      && sameExecution(profile.executionIdentity, executionIdentity(plan));
    const conversationId = ephemeralVerifier ? plan.conversationId : toolContext.conversationId;
    const workspaceId = profile.workspaceId;
    const owner = normalizeInteractiveOwner({ workspaceId, conversationId: getBotConversationId?.(workspaceId) });
    const currentOwner = () => !!owner && holdsLease?.(workspaceId) === true && getBotConversationId(workspaceId) === owner.conversationId;
    if (!currentOwner() || toolContext.workspaceId && toolContext.workspaceId !== workspaceId) throw problem('interactive_scope_denied');
    if (enabled?.(workspaceId) !== true && resultStore.hasOwnerPrivacy?.(owner) !== true) throw problem('interactive_scope_denied');
    if (profile.role === 'project_agent' ? conversationId !== owner.conversationId
      : plan?.conversationId !== conversationId || plan?.delegationOrigin?.workspaceId !== workspaceId
        || plan.delegationOrigin.parentConversationId !== owner.conversationId || plan.delegationOrigin.sessionId !== profile.sessionId) throw problem('interactive_scope_denied');
    return { owner, dataLevel: classifyContext?.({ owner, plan, toolContext }), assertCurrent: currentOwner };
  }
  return { resolve, resolveObservation };
}
