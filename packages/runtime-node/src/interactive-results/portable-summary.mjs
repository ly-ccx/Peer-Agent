import { INTERACTIVE_PUBLISH_CAPABILITY, INTERACTIVE_PUBLISH_TOOL, INTERACTIVE_RESULT_LIMITS,
  interactiveArtifactRef, interactiveToken, normalizeInteractivePublicationReference,
  normalizeInteractiveReference, normalizeInteractiveUserArtifact } from '@peer-agent/protocol';
import { encode } from './storage.mjs';

const same = (a, b) => encode(a) === encode(b);

/** A portable Tool Result is a display fallback only. The original publication stays device-local. */
export function createPortableInteractiveSummaryReader({ goalPlanStore, readWorkHistory }) {
  return function readPortableSummary(rawReference) {
    const reference = normalizeInteractiveReference(rawReference);
    if (!reference || typeof readWorkHistory !== 'function') return null;
    const { owner } = reference, ref = interactiveArtifactRef(reference);
    try {
      const [record] = goalPlanStore.findEvidenceIndexRecords([ref]);
      const artifact = record?.userArtifacts?.map(normalizeInteractiveUserArtifact).find(row => row?.ref === ref);
      if (record?.evidenceRef !== ref || record.capabilityId !== INTERACTIVE_PUBLISH_CAPABILITY || record.toolName !== INTERACTIVE_PUBLISH_TOOL
        || !record.artifactRefs?.includes(ref) || !artifact || !same(artifact.reference, reference)
        || ![record.planId, record.conversationId, record.toolCallId].every(interactiveToken)) return null;
      const plan = goalPlanStore.getPlan(record.planId), origin = plan?.delegationOrigin;
      if (plan?.planId !== record.planId || plan.conversationId !== record.conversationId || origin?.workspaceId !== owner.workspaceId
        || origin.parentConversationId !== owner.conversationId || !interactiveToken(origin.sessionId)) return null;
      const history = readWorkHistory({ workspaceId: owner.workspaceId, parentConversationId: owner.conversationId,
        conversationId: record.conversationId, sessionId: origin.sessionId });
      if (history?.conversationId !== record.conversationId) return null;
      let published;
      for (const message of history.messages) {
        if (message.role !== 'assistant' || message.interrupted === true) continue;
        for (const call of message.segments ?? []) {
          if (call?.type !== 'tool-call' || call.toolCallId !== record.toolCallId) continue;
          if (published || call.tool !== INTERACTIVE_PUBLISH_TOOL || typeof call.result !== 'string'
            || Buffer.byteLength(call.result, 'utf8') > 128 * 1024) return null;
          const saved = JSON.parse(call.result);
          if (saved?.kind === 'local_capability_result_ref') {
            if (saved.tool !== INTERACTIVE_PUBLISH_TOOL || saved.capabilityId !== INTERACTIVE_PUBLISH_CAPABILITY
              || saved.status !== 'success' || !Number.isFinite(call.endedAtMs)) return null;
            published = { output: saved.outputPreview, evidenceRefs: saved.evidenceRefs };
          } else {
            if (call.status !== 'completed' || saved?.status !== 'completed') return null;
            published = saved;
          }
        }
      }
      const output = published?.output, originalCall = normalizeInteractivePublicationReference(output?.callRef);
      if (output?.kind !== 'interactive_publication' || output.publicationStatus !== 'published' || output.unchanged === true
        || !originalCall || !same(originalCall, { owner, conversationId: record.conversationId, toolCallId: record.toolCallId })
        || !same(normalizeInteractiveReference(output.reference), reference) || output.artifactRef !== ref
        || !Array.isArray(published.evidenceRefs) || !published.evidenceRefs.includes(ref) || output.title !== artifact.label
        || typeof output.textFallback !== 'string' || Buffer.byteLength(output.textFallback, 'utf8') > INTERACTIVE_RESULT_LIMITS.fallbackBytes) return null;
      const textFallback = Array.from(output.textFallback).slice(0, 8192).join('');
      const summary = { schemaVersion: 1, availability: 'origin_only', summaryKind: 'saved-model-summary', ref, reference,
        source: { conversationId: record.conversationId, planId: record.planId, sessionId: origin.sessionId, toolCallId: record.toolCallId },
        title: artifact.label, textFallback, truncated: textFallback.length < output.textFallback.length };
      return { record, summary };
    } catch { return null; }
  };
}
