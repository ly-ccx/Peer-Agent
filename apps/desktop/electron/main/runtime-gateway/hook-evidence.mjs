import { nowIso } from './tool-result-factory.mjs';

function sanitizeHookRecord(record) {
  return {
    id: record.id,
    event: record.event,
    decision: record.decision,
    reason: record.reason,
    outcome: record.outcome,
    durationMs: record.durationMs,
    exitCode: record.exitCode,
  };
}

export function appendHookEvidence(result, hookRecords = [], finalDecision = undefined) {
  if (!result || !Array.isArray(hookRecords) || hookRecords.length === 0) return result;

  const existingEvidence = result.evidence && typeof result.evidence === 'object'
    ? result.evidence
    : {
        evidenceId: `hook-${result.toolCallId ?? 'unknown'}`,
        toolCallId: result.toolCallId,
        summary: 'Hook decision evidence.',
        locale: result.locale ?? 'en-US',
        returnedToCloud: false,
        dataLevel: result.dataLevel ?? 'D0_public',
        redactions: [],
        artifactRefs: [],
      };

  const existingHooks = Array.isArray(existingEvidence.hooks) ? existingEvidence.hooks : [];
  return {
    ...result,
    evidence: {
      ...existingEvidence,
      hooks: [
        ...existingHooks,
        ...hookRecords.map(sanitizeHookRecord),
      ],
      hookFinalDecision: finalDecision ?? existingEvidence.hookFinalDecision,
      hookRecordedAt: nowIso(),
    },
  };
}
