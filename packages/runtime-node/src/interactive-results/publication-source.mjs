import { INTERACTIVE_PUBLISH_CAPABILITY, INTERACTIVE_PUBLISH_TOOL, interactiveToken, normalizeInteractiveOwner,
  normalizeInteractiveUserArtifact, parseInteractiveArtifactRef } from '@peer-agent/protocol';
import { encode, problem } from './storage.mjs';

const same = (a, b) => encode(a) === encode(b);

/** Human evidence retrieval only. Model reads continue through the inspect Provider. */
export function createInteractivePublicationSource({ resultStore, goalPlanStore, getBotConversationId, getSession }) {
  function ownerFor(workspaceId) {
    const owner = normalizeInteractiveOwner({ workspaceId, conversationId: getBotConversationId?.(workspaceId) });
    if (!owner) throw problem('interactive_scope_denied');
    return owner;
  }
  function taskFor(owner, task, { allowUnbound = false } = {}) {
    if (!task || !interactiveToken(task.planId) || !interactiveToken(task.sessionId)) throw problem('interactive_scope_denied');
    const plan = goalPlanStore.getPlan(task.planId), origin = plan?.delegationOrigin;
    if (plan?.planId !== task.planId || !interactiveToken(plan.conversationId) || origin?.workspaceId !== owner.workspaceId
      || origin.sessionId !== task.sessionId) throw problem('interactive_scope_denied');
    // Old file evidence can predate the parent binding; it gains no interactive identity.
    if (allowUnbound && !origin.parentConversationId) return null;
    if (origin.parentConversationId !== owner.conversationId) throw problem('interactive_scope_denied');
    const session = getSession?.(task.sessionId);
    if (!session) throw problem('interactive_publication_unavailable');
    if (session.sessionId !== task.sessionId || session.workspaceId !== owner.workspaceId || session.report?.planId !== task.planId) throw problem('interactive_scope_denied');
    return plan;
  }
  return {
    resolveEvidence(evidenceRef, context) {
      const reference = parseInteractiveArtifactRef(evidenceRef);
      const alias = typeof evidenceRef === 'string' && evidenceRef.startsWith('tool-result://') ? evidenceRef.slice(14) : null;
      if (!reference && (!interactiveToken(alias) || !context?.task)) return null;
      if (!context || !interactiveToken(context.workspaceId)) throw problem('interactive_scope_denied');
      const owner = ownerFor(context.workspaceId);
      let target = reference, requestPlan, operation;
      if (context.task !== undefined) {
        requestPlan = taskFor(owner, context.task, { allowUnbound: !!alias });
        if (!requestPlan) return null;
      }
      if (alias) {
        const call = { owner, conversationId: requestPlan.conversationId, toolCallId: alias };
        operation = resultStore.getOperation(call);
        if (!operation) return null;
        if (operation.publicationStatus !== 'published' || !same(operation.callRef, call)) throw problem('interactive_publication_unavailable');
        target = operation.reference;
      }
      if (!target || !same(target.owner, owner)) throw problem('interactive_scope_denied');
      const descriptor = resultStore.getVersionMetadata(target), source = descriptor.source;
      const task = { planId: source.planId, sessionId: source.sessionId }, sourcePlan = taskFor(owner, task);
      if (sourcePlan.conversationId !== source.conversationId || !interactiveToken(source.toolCallId)
        || requestPlan && (requestPlan.planId !== source.planId || alias && source.toolCallId !== alias) && !operation?.unchanged) throw problem('interactive_scope_denied');
      const fixed = resultStore.getVersion(target);
      const { content: _content, provenance: _provenance, ...actualDescriptor } = fixed;
      if (!same(descriptor, actualDescriptor)) throw problem('interactive_publication_unavailable');
      const record = goalPlanStore.findEvidenceIndexRecords([fixed.evidenceRef]).find(row => row.evidenceRef === fixed.evidenceRef);
      const artifact = record?.userArtifacts?.map(normalizeInteractiveUserArtifact).find(row => row?.ref === fixed.artifactRef);
      if (!record || !artifact || !same(artifact.reference, target) || artifact.specHash !== fixed.content.specHash || artifact.label !== fixed.content.title
        || record.planId !== source.planId || record.conversationId !== source.conversationId || record.toolCallId !== source.toolCallId
        || record.capabilityId !== INTERACTIVE_PUBLISH_CAPABILITY || record.toolName !== INTERACTIVE_PUBLISH_TOOL
        || record.evidenceRef !== fixed.artifactRef || record.createdAt !== fixed.createdAt) throw problem('interactive_publication_unavailable');
      if (!same(ownerFor(context.workspaceId), owner)) throw problem('interactive_scope_denied');
      return { record, context: { workspaceId: owner.workspaceId, task },
        body: { text: `Saved model summary, unverified\n${fixed.content.textFallback}`, truncated: false } };
    },
  };
}
