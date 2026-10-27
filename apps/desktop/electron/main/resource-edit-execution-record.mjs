import { createHash } from 'node:crypto';
import { normalizeResourceEditExecutionRecord, normalizeResourceEditPostlude, normalizeResourceFileReplacePreview, resourceFileReplaceArgumentPayload } from '@peer-agent/protocol';
const hash = text => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const issue = code => Object.assign(Error(code), { code });
/** Called only with the actual Provider/SDK return, never parsed assistant text or IPC facts. */
export function captureResourceEditExecution(operation, execution, projection) {
  const call = execution?.call, grant = execution?.grant, result = execution?.result, evidence = result?.evidence;
  if (!call || !grant || !result || !evidence) throw issue('RESOURCE_EDIT_INVALID_EXECUTION');
  if (![call.toolCallId, `chat-permission:${call.toolCallId}`].includes(grant.toolCallId)) throw issue('RESOURCE_EDIT_INVALID_EXECUTION');
  const observation = normalizeResourceFileReplacePreview(result.outputPreview);
  const permissionCallId = observation?.permissionCallId ?? (grant.toolCallId !== call.toolCallId ? grant.toolCallId : undefined);
  const blockedReason = !observation && grant.granted === false && ['denied', 'cancelled'].includes(result.status) ? result.outputPreview?.reason : undefined;
  const record = normalizeResourceEditExecutionRecord({ schemaVersion: 1, workspaceId: operation.target.recipient.workspaceId, requestId: operation.requestId,
    payloadHash: operation.payloadHash, projectionId: projection.projectionId, sessionId: projection.sessionId,
    call: { toolCallId: call.toolCallId, capabilityId: call.capabilityId, toolName: call.toolName, argumentsDigest: hash(resourceFileReplaceArgumentPayload(call.arguments)), occurredAt: call.occurredAt,
      ...(permissionCallId ? { permissionCallId } : {}) },
    grant: { grantId: grant.grantId, toolCallId: call.toolCallId, granted: grant.granted, duration: grant.duration, scope: grant.scope, decidedAt: grant.decidedAt,
      ...(grant.policyRevision !== undefined ? { policyRevision: grant.policyRevision } : {}) },
    result: { toolCallId: result.toolCallId, status: result.status, completedAt: result.completedAt, ...(observation ? { observation } : { blockedReason }),
      evidence: { evidenceId: evidence.evidenceId, toolCallId: evidence.toolCallId, summary: evidence.summary, locale: evidence.locale, returnedToCloud: evidence.returnedToCloud,
        dataLevel: evidence.dataLevel, redactions: evidence.redactions, artifactRefs: evidence.artifactRefs } } });
  if (!record) throw issue('RESOURCE_EDIT_INVALID_EXECUTION');
  return record;
}
export function captureResourceEditPostlude(operation, execution, { reason, now = () => new Date().toISOString() } = {}) {
  const evidence = execution?.result?.evidence;
  const hooks = Array.isArray(evidence?.hooks) ? evidence.hooks.map(item => Object.fromEntries(['id', 'event', 'decision', 'reason', 'outcome', 'durationMs', 'exitCode']
    .filter(key => item[key] !== undefined).map(key => [key, item[key]]))) : [];
  const value = normalizeResourceEditPostlude({ schemaVersion: 1, requestId: operation.requestId, payloadHash: operation.payloadHash, completedAt: now(),
    status: reason ? 'unconfirmed' : 'recorded', ...(reason ? { reason } : {}), ...(evidence?.hookFinalDecision !== undefined ? { hookFinalDecision: evidence.hookFinalDecision } : {}), hooks });
  if (!value) throw issue('RESOURCE_EDIT_INVALID_POSTLUDE'); return value;
}
