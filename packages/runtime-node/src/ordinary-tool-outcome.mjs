import { collectToolEvidenceRefs } from '@peer-agent/runtime-core';
import { toolResultEvidencePreview } from './project-agent/tool-result-evidence-preview.mjs';

/** Adapt the actual Node Provider's grant to the shared retained-message shape. */
export function ordinaryToolGrant(call, grant) {
  if (grant?.capabilityId !== call.capabilityId
    || grant.toolCallId !== undefined && grant.toolCallId !== call.toolCallId
    || !['allow', 'deny'].includes(grant.decision)) throw new Error('conversation_execution_invalid');
  const granted = grant.decision === 'allow';
  return JSON.parse(JSON.stringify({
    ...grant, toolCallId: call.toolCallId, granted, decidedAt: grant.grantedAt,
    scope: call.capabilityId, duration: granted ? 'once' : 'denied',
  }));
}

/** Publish only the Host's actual tool observation, then settle against durable Evidence. */
export function commitOrdinaryToolOutcome({ prepared, execution, identity, toolName, evidenceIndex, completedAt }) {
  const { permissionGrant, ...observed } = execution.result;
  const grant = ordinaryToolGrant(observed, permissionGrant);
  const result = JSON.parse(JSON.stringify({
    ...observed, status: observed.status === 'completed' ? 'success' : observed.status, completedAt,
  }));
  prepared.publishResult(result, grant);
  const evidenceRefs = collectToolEvidenceRefs({ toolCallId: result.toolCallId, execution });
  evidenceIndex.recordEvidenceRefs({
    conversationId: identity.conversationId, streamId: identity.streamId, toolName,
    toolCallId: result.toolCallId, capabilityId: result.capabilityId,
    evidenceRefs, artifactRefs: evidenceRefs.filter(ref => !ref.startsWith('tool-result://')),
    bodyPreview: toolResultEvidencePreview(execution), createdAt: completedAt,
  }, { durable: true, protectToolOrigin: true });
  prepared.settle();
}
