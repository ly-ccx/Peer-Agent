import { normalizeInteractiveInspectionReceipt, interactiveInspectionEvidenceRef } from '@peer-agent/protocol';
import { encode, jsonDigest, problem } from './storage.mjs';

/** Complete a real readonly Provider's existing Evidence return responsibility. No body store or grant recovery. */
export function recordInteractiveInspection({ call, authority, request, output, index, guard, evidenceId, observedAt }) {
  const state = output.stateSource;
  const stateSource = state && { kind: state.kind, stateDigest: state.stateDigest,
    ...(state.kind === 'frozen-followup' ? { followupId: state.followupId, stateRevision: state.stateRevision, selectionDigest: state.selectionDigest } : {}) };
  const receipt = normalizeInteractiveInspectionReceipt({ schemaVersion: 1, evidenceId, owner: authority.owner,
    execution: Object.fromEntries(Object.entries(authority.source ?? {}).filter(([key]) => ['planId', 'sessionId', 'executionEpoch', 'goalRevision', 'generation'].includes(key))),
    conversationId: authority.source?.conversationId, toolCallId: call.toolCallId, specHash: output.specHash,
    request, review: authority.inspectionReview, ...(typeof output.text === 'string' ? { range: {
      offset: output.offset, returned: output.text.length, total: output.total, truncated: output.truncated } } : {}),
    ...(stateSource ? { stateSource, computationTruncated: output.computationTruncated } : {}), outputDigest: jsonDigest(output), observedAt });
  if (!receipt) throw problem('interactive_inspection_receipt_invalid');
  guard();
  if (index?.assertInteractiveEvidenceCompatible?.() !== true || !index?.recordEvidenceRefs || !index?.findEvidenceIndexRecords) throw problem('interactive_evidence_incompatible');
  const evidenceRef = interactiveInspectionEvidenceRef(evidenceId);
  index.recordEvidenceRefs({ evidenceRef, evidenceRefs: [evidenceRef], planId: receipt.execution.planId, conversationId: receipt.conversationId,
    toolCallId: receipt.toolCallId, capabilityId: 'local.interactive.inspect', toolName: 'inspect_interactive_result',
    createdAt: receipt.observedAt, interactiveInspection: receipt }, { durable: true });
  const actual = index.findEvidenceIndexRecords([evidenceRef]).find(row => row.evidenceRef === evidenceRef);
  if (!actual?.interactiveInspection || encode(actual.interactiveInspection) !== encode(receipt)) throw problem('interactive_inspection_index_unconfirmed');
  guard(); return evidenceRef;
}
