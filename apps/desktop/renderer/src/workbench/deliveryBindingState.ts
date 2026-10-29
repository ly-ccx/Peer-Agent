import type { BotDocumentReference, EvidenceDeliveryBinding, ProjectAgentEvidenceReadResult } from '@peer-agent/protocol';
export function normalizeDeliveryBinding(raw: unknown): EvidenceDeliveryBinding | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const value = raw as EvidenceDeliveryBinding;
  if (typeof value.evidenceRef !== 'string' || !value.evidenceRef || value.evidenceRef.length > 500 || /[\s\u0000-\u001f\\]/.test(value.evidenceRef)
    || value.evidenceRef.includes('..') || typeof value.artifactRef !== 'string' || !value.artifactRef.trim()
    || value.artifactRef.length > 8192 || /[\u0000-\u001f]/.test(value.artifactRef)) return;
  return { evidenceRef: value.evidenceRef, artifactRef: value.artifactRef };
}
export const deliveryBindingKey = (value: EvidenceDeliveryBinding | undefined) => value ? JSON.stringify([value.evidenceRef, value.artifactRef]) : '';
/** Persisted navigation is only a hint: match a fresh host projection, including the actual task. */
export function confirmedDelivery(result: ProjectAgentEvidenceReadResult | null | undefined, binding: EvidenceDeliveryBinding, reference: BotDocumentReference) {
  if (result?.deliveryStatus !== 'available' || result.evidenceRef !== binding.evidenceRef) return;
  return result.deliveries?.find(item => item.evidenceRef === binding.evidenceRef && item.artifactRef === binding.artifactRef
    && item.reference?.workspaceId === reference.workspaceId && item.reference.path === reference.path
    && (item.reference.task?.sessionId ?? '') === (reference.task?.sessionId ?? '')
    && (item.reference.task?.planId ?? '') === (reference.task?.planId ?? ''));
}
