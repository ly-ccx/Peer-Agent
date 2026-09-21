/** Inputs are resolved by the local evidence authority, never trusted from model arguments.
 * Pure checking here does not authorize preview execution or validate image bytes.
 */
export interface UiDeliveryIdentity {
  readonly requirementRevision: string;
  readonly buildFingerprint: string;
  readonly instanceId: string;
}
export interface UiDeliveryRequirement extends UiDeliveryIdentity {
  readonly id: string;
  readonly host: 'web' | 'desktop';
}
export interface UiDeliveryObservation extends UiDeliveryIdentity {
  readonly requirementId: string;
  readonly host: 'web' | 'desktop';
  readonly evidenceRef: string;
  readonly artifactHash: string;
  /** Local image validation and context admission, not a model assertion. */
  readonly admittedToRunId: string;
}
export interface UiDeliveryJudgment {
  readonly requirementId: string;
  readonly observationRef: string;
  readonly modelRunId: string;
  readonly evidenceRef: string;
  readonly decision: 'passed' | 'failed' | 'unknown';
}
export type UiDeliveryGap = 'invalid-requirement' | 'judgment-missing' | 'judgment-unresolved'
  | 'judgment-failed' | 'judgment-unknown' | 'observation-missing' | 'observation-unresolved'
  | 'observation-stale' | 'image-not-admitted' | 'invalid-record';

/** Empty requirements preserve legacy non-UI behavior. The host must supply the
 * authoritative requirements and current identities; callers cannot omit UI pins.
 * Last judgment per requirement supersedes earlier success, including failed reruns.
 */
export function evaluateUiDelivery(
  requirements: readonly UiDeliveryRequirement[],
  observations: readonly UiDeliveryObservation[],
  judgments: readonly UiDeliveryJudgment[],
  knownEvidenceRefs: ReadonlySet<string>,
): { passed: boolean; gaps: { requirementId: string; reason: UiDeliveryGap }[] } {
  // Persisted JSON may be corrupt despite static types. Do not discard bad
  // records: dropping a malformed latest judgment could resurrect an old pass.
  if (![requirements, observations, judgments].every(list => Array.isArray(list)
    && list.every(item => item !== null && typeof item === 'object' && !Array.isArray(item)))) {
    return { passed: false, gaps: [{ requirementId: '', reason: 'invalid-record' }] };
  }
  const gaps: { requirementId: string; reason: UiDeliveryGap }[] = [];
  const latest = new Map(judgments.map(j => [j.requirementId, j]));
  const seen = new Set<string>();
  for (const r of requirements) {
    const add = (reason: UiDeliveryGap) => gaps.push({ requirementId: r.id, reason });
    if (![r.id, r.requirementRevision, r.buildFingerprint, r.instanceId].every(nonempty)
      || !['web', 'desktop'].includes(r.host) || seen.has(r.id)) {
      add('invalid-requirement'); continue;
    }
    seen.add(r.id);
    const j = latest.get(r.id);
    if (!j) { add('judgment-missing'); continue; }
    if (!nonempty(j.evidenceRef) || !knownEvidenceRefs.has(j.evidenceRef)) {
      add('judgment-unresolved'); continue;
    }
    if (j.decision !== 'passed') {
      add(j.decision === 'failed' ? 'judgment-failed' : 'judgment-unknown'); continue;
    }
    const matches = observations.filter(o => o.evidenceRef === j.observationRef);
    if (matches.length !== 1) { add('observation-missing'); continue; }
    const o = matches[0]!;
    if (!nonempty(o.evidenceRef) || !knownEvidenceRefs.has(o.evidenceRef)) {
      add('observation-unresolved'); continue;
    }
    if (o.requirementId !== r.id || o.host !== r.host
      || o.requirementRevision !== r.requirementRevision
      || o.buildFingerprint !== r.buildFingerprint || o.instanceId !== r.instanceId) {
      add('observation-stale'); continue;
    }
    if (!nonempty(o.artifactHash) || !nonempty(j.modelRunId)
      || o.admittedToRunId !== j.modelRunId) add('image-not-admitted');
  }
  return { passed: gaps.length === 0, gaps };
}
function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
