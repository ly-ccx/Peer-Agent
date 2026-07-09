import { appendHookEvidence as appendCoreHookEvidence } from '@peer-agent/runtime-core';
import { nowIso } from './tool-result-factory.mjs';

function ensureHookEvidenceBase(result) {
  if (result.evidence && typeof result.evidence === 'object') return result;

  return {
    ...result,
    evidence: {
      evidenceId: `hook-${result.toolCallId ?? 'unknown'}`,
      toolCallId: result.toolCallId,
      summary: 'Hook decision evidence.',
      locale: result.locale ?? 'en-US',
      returnedToCloud: false,
      dataLevel: result.dataLevel ?? 'D0_public',
      redactions: [],
      artifactRefs: [],
    },
  };
}

export function appendHookEvidence(result, hookRecords = [], finalDecision = undefined) {
  if (!result || !Array.isArray(hookRecords) || hookRecords.length === 0) return result;
  return appendCoreHookEvidence(ensureHookEvidenceBase(result), hookRecords, finalDecision, { now: nowIso });
}
