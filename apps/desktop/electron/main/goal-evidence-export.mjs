import { collectHeldEvidenceRefs, projectAcceptanceBasis } from '@peer-agent/protocol';
import {
  createEvidenceExportDocument,
  serializeEvidenceExportDocument,
} from '@peer-agent/runtime-core';

function trimText(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Pack a GoalPlan's already-held refs into a portable export.
 * Does not scan assistant text or enlarge the Evidence whitelist.
 */
export function buildPlanEvidenceExport(plan, {
  now = () => new Date().toISOString(),
  findIndexRecords,
} = {}) {
  if (!plan || typeof plan !== 'object') return null;
  const refs = [...collectHeldEvidenceRefs(plan)];
  const basis = projectAcceptanceBasis(plan);
  const indexRecords = typeof findIndexRecords === 'function'
    ? findIndexRecords(refs)
    : [];
  return createEvidenceExportDocument({
    exportedAt: now(),
    source: {
      planId: plan.planId,
      conversationId: trimText(plan.conversationId),
    },
    summary: trimText(plan.title) ?? trimText(plan.goal),
    refs,
    metadata: {
      authorization: basis.authorization,
      ...(Array.isArray(indexRecords) && indexRecords.length > 0
        ? { indexRecords }
        : {}),
      ...(plan.resultAcceptance ? { resultAcceptance: plan.resultAcceptance } : {}),
    },
  });
}

export { serializeEvidenceExportDocument };
