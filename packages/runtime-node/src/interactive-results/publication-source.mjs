import { INTERACTIVE_PUBLISH_CAPABILITY, INTERACTIVE_PUBLISH_TOOL, interactiveToken, normalizeInteractiveOwner,
  normalizeInteractiveUserArtifact, parseInteractiveArtifactRef } from '@peer-agent/protocol';
import { encode, problem } from './storage.mjs';
import { sessionReportEvidenceRefs } from '../project-agent/session-report.mjs';

const same = (a, b) => encode(a) === encode(b);

/** Published identity projection. Model program/data reads still require the inspect Provider. */
export function createInteractivePublicationSource({ resultStore, goalPlanStore, getBotConversationId, getSession }) {
  function ownerFor(workspaceId) {
    const owner = normalizeInteractiveOwner({ workspaceId, conversationId: getBotConversationId?.(workspaceId) });
    if (!owner) throw problem('interactive_scope_denied');
    return owner;
  }
  function planFor(owner, task, { allowUnbound = false } = {}) {
    if (!task || !interactiveToken(task.planId) || !interactiveToken(task.sessionId)) throw problem('interactive_scope_denied');
    const plan = goalPlanStore.getPlan(task.planId), origin = plan?.delegationOrigin;
    if (plan?.planId !== task.planId || !interactiveToken(plan.conversationId) || origin?.workspaceId !== owner.workspaceId
      || origin.sessionId !== task.sessionId) throw problem('interactive_scope_denied');
    // Old file evidence can predate the parent binding; it gains no interactive identity.
    if (allowUnbound && !origin.parentConversationId) return null;
    if (origin.parentConversationId !== owner.conversationId) throw problem('interactive_scope_denied');
    return plan;
  }
  function requireSession(owner, plan) {
    const sessionId = plan.delegationOrigin.sessionId, session = getSession?.(sessionId);
    if (!session) throw problem('interactive_publication_unavailable');
    if (session.sessionId !== sessionId || session.workspaceId !== owner.workspaceId || session.report?.planId !== plan.planId) throw problem('interactive_scope_denied');
  }
  function publicationProof(target, owner, requestPlan, operation, alias) {
    if (!target || !same(target.owner, owner)) throw problem('interactive_scope_denied');
    const descriptor = resultStore.getVersionMetadata(target), source = descriptor.source;
    const sourcePlan = planFor(owner, { planId: source.planId, sessionId: source.sessionId });
    if (sourcePlan.conversationId !== source.conversationId || !interactiveToken(source.toolCallId)
      || requestPlan && (requestPlan.planId !== source.planId || alias && source.toolCallId !== alias) && !operation?.unchanged) throw problem('interactive_scope_denied');
    const original = resultStore.getOperation({ owner, conversationId: source.conversationId, toolCallId: source.toolCallId });
    const { publicationStatus, ...metadata } = descriptor;
    if (original?.publicationStatus !== 'published' || original.unchanged || !same(original.reference, target)
      || !same(original.metadata, metadata)) throw problem('interactive_publication_unavailable');
    const record = goalPlanStore.findEvidenceIndexRecords([descriptor.evidenceRef]).find(row => row.evidenceRef === descriptor.evidenceRef);
    const artifact = record?.userArtifacts?.map(normalizeInteractiveUserArtifact).find(row => row?.ref === descriptor.artifactRef);
    const expected = original.indexEntry?.userArtifacts?.map(normalizeInteractiveUserArtifact).find(row => row?.ref === descriptor.artifactRef);
    if (!record || !artifact || !expected || !same(artifact, expected) || !same(artifact.reference, target)
      || record.planId !== source.planId || record.conversationId !== source.conversationId || record.toolCallId !== source.toolCallId
      || record.capabilityId !== INTERACTIVE_PUBLISH_CAPABILITY || record.toolName !== INTERACTIVE_PUBLISH_TOOL
      || record.evidenceRef !== descriptor.artifactRef || record.createdAt !== descriptor.createdAt) throw problem('interactive_publication_unavailable');
    return { descriptor, sourcePlan, record, artifact };
  }
  function referenceFor(plan, owner, ref) {
    let target = parseInteractiveArtifactRef(ref), operation, alias;
    if (!target) {
      alias = typeof ref === 'string' && ref.startsWith('tool-result://') ? ref.slice(14) : null;
      if (!interactiveToken(alias)) return null;
      const call = { owner, conversationId: plan.conversationId, toolCallId: alias };
      operation = resultStore.getOperation(call);
      if (!operation) return null;
      if (operation.publicationStatus !== 'published' || !same(operation.callRef, call)) throw problem('interactive_publication_unavailable');
      target = operation.reference;
    }
    return publicationProof(target, owner, plan, operation, alias).record.evidenceRef;
  }
  function reportPlan(raw) {
    const origin = raw?.delegationOrigin, owner = ownerFor(origin?.workspaceId);
    const plan = planFor(owner, { planId: raw?.planId, sessionId: origin?.sessionId });
    if (raw.conversationId !== plan.conversationId) throw problem('interactive_scope_denied');
    return { plan, owner };
  }
  return {
    projectReportEvidence(rawPlan, refs) {
      try {
        const { plan, owner } = reportPlan(rawPlan), admitted = new Set(sessionReportEvidenceRefs(plan));
        const projected = refs.map(ref => {
          if (!admitted.has(ref)) return ref;
          try { return referenceFor(plan, owner, ref) ?? ref; } catch { return ref; }
        });
        return same(ownerFor(owner.workspaceId), owner) ? [...new Set(projected)] : [...refs];
      } catch { return [...refs]; }
    },
    replyReferences({ workspaceId, conversationId, sessionIds }) {
      if (!Array.isArray(sessionIds) || sessionIds.length > 20 || sessionIds.some(id => !interactiveToken(id))) throw problem('interactive_scope_denied');
      if (!sessionIds.length) return [];
      const owner = ownerFor(workspaceId);
      if (owner.conversationId !== conversationId) throw problem('interactive_scope_denied');
      const refs = new Set();
      for (const id of sessionIds) {
        const session = getSession?.(id, 'summary');
        if (session?.sessionId !== id || session.workspaceId !== workspaceId) throw problem('interactive_scope_denied');
        const plan = planFor(owner, { planId: session.planId ?? session.report?.planId, sessionId: id }, { allowUnbound: true });
        if (!plan || refs.size >= 20) continue;
        for (const ref of sessionReportEvidenceRefs(plan)) {
          try { const fixed = referenceFor(plan, owner, ref); if (fixed) refs.add(fixed); } catch { /* Unconfirmed references retain their original task trace only. */ }
          if (refs.size >= 20) break;
        }
      }
      if (!same(ownerFor(workspaceId), owner)) throw problem('interactive_scope_denied');
      return [...refs];
    },
    resolveEvidence(evidenceRef, context) {
      const reference = parseInteractiveArtifactRef(evidenceRef);
      const alias = typeof evidenceRef === 'string' && evidenceRef.startsWith('tool-result://') ? evidenceRef.slice(14) : null;
      if (!reference && (!interactiveToken(alias) || !context?.task)) return null;
      if (!context || !interactiveToken(context.workspaceId)) throw problem('interactive_scope_denied');
      const owner = ownerFor(context.workspaceId);
      let target = reference, requestPlan, operation;
      if (context.task !== undefined) {
        requestPlan = planFor(owner, context.task, { allowUnbound: !!alias });
        if (!requestPlan) return null;
        requireSession(owner, requestPlan);
      }
      if (alias) {
        const call = { owner, conversationId: requestPlan.conversationId, toolCallId: alias };
        operation = resultStore.getOperation(call);
        if (!operation) return null;
        if (operation.publicationStatus !== 'published' || !same(operation.callRef, call)) throw problem('interactive_publication_unavailable');
        target = operation.reference;
      }
      const { descriptor, sourcePlan, record, artifact } = publicationProof(target, owner, requestPlan, operation, alias);
      requireSession(owner, sourcePlan);
      const task = { planId: sourcePlan.planId, sessionId: sourcePlan.delegationOrigin.sessionId };
      const fixed = resultStore.getVersion(target);
      const { content: _content, provenance: _provenance, ...actualDescriptor } = fixed;
      if (!same(descriptor, actualDescriptor) || artifact.specHash !== fixed.content.specHash || artifact.label !== fixed.content.title) throw problem('interactive_publication_unavailable');
      if (!same(ownerFor(context.workspaceId), owner)) throw problem('interactive_scope_denied');
      return { record, context: { workspaceId: owner.workspaceId, task },
        body: { text: `Saved model summary, unverified\n${fixed.content.textFallback}`, truncated: false } };
    },
  };
}
