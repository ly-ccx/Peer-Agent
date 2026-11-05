import { interactiveDigest, interactiveToken, normalizeInteractiveInspect, normalizeInteractiveOwner, type InteractiveInspectRequest,
  type InteractiveOwner } from './interactive-result.ts';
import { normalizeSessionExecutionIdentity, type SessionExecutionIdentity } from './session-control.ts';

/** Opaque host-only lifetime binding; never model context or execution permission. */
export interface InteractiveReviewBinding { readonly token: string }
export interface InteractiveInspectionReceipt {
  readonly schemaVersion: 1;
  readonly evidenceId: string;
  readonly owner: InteractiveOwner;
  readonly execution: SessionExecutionIdentity;
  readonly conversationId: string;
  readonly toolCallId: string;
  readonly specHash: string;
  readonly request: InteractiveInspectRequest;
  readonly review: { readonly verifierRunId: string; readonly sourceRevision: string; readonly targetsDigest: string };
  readonly range?: { readonly offset: number; readonly returned: number; readonly total: number; readonly truncated: boolean };
  readonly stateSource?: { readonly kind: 'initial' | 'frozen-followup'; readonly stateDigest: string; readonly followupId?: string;
    readonly stateRevision?: number; readonly selectionDigest?: string };
  readonly computationTruncated?: boolean;
  readonly outputDigest: string;
  readonly observedAt: string;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v)) && Object.values(Object.getOwnPropertyDescriptors(v)).every(d => 'value' in d);
const keys = (v: Record<string, unknown>, allowed: readonly string[]) => Object.keys(v).every(key => allowed.includes(key));
const integer = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 512 * 1024;
export function normalizeInteractiveReviewBinding(raw: unknown): InteractiveReviewBinding | undefined {
  return object(raw) && keys(raw, ['token']) && interactiveToken(raw.token) ? { token: raw.token } : undefined;
}
const INSPECTION_REF_PREFIX = 'interactive-inspection://';
export function interactiveInspectionEvidenceRef(evidenceId: string) {
  if (!interactiveToken(evidenceId)) throw TypeError('invalid inspection evidence ID');
  return `${INSPECTION_REF_PREFIX}${evidenceId}`;
}
export function isInteractiveInspectionEvidenceRef(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.startsWith(INSPECTION_REF_PREFIX) && interactiveToken(raw.slice(INSPECTION_REF_PREFIX.length));
}
export function normalizeInteractiveInspectionReceipt(raw: unknown): InteractiveInspectionReceipt | undefined {
  if (!object(raw) || !keys(raw, ['schemaVersion', 'evidenceId', 'owner', 'execution', 'conversationId', 'toolCallId', 'specHash', 'request', 'review', 'range', 'stateSource', 'computationTruncated', 'outputDigest', 'observedAt'])
    || raw.schemaVersion !== 1 || !interactiveToken(raw.evidenceId) || !interactiveToken(raw.conversationId) || !interactiveToken(raw.toolCallId)
    || !interactiveDigest(raw.specHash) || !interactiveDigest(raw.outputDigest) || typeof raw.observedAt !== 'string' || raw.observedAt.length > 40 || !Number.isFinite(Date.parse(raw.observedAt))
    || !object(raw.review) || !keys(raw.review, ['verifierRunId', 'sourceRevision', 'targetsDigest']) || !interactiveToken(raw.review.verifierRunId)
    || typeof raw.review.sourceRevision !== 'string' || !/^[a-f0-9]{64}$/.test(raw.review.sourceRevision) || !interactiveDigest(raw.review.targetsDigest)
    || raw.computationTruncated !== undefined && typeof raw.computationTruncated !== 'boolean') return;
  const owner = normalizeInteractiveOwner(raw.owner), execution = normalizeSessionExecutionIdentity(raw.execution), request = normalizeInteractiveInspect(raw.request);
  if (!owner || !execution || !request || request.target.kind !== 'result'
    || owner.workspaceId !== request.target.reference.owner.workspaceId || owner.conversationId !== request.target.reference.owner.conversationId) return;
  let range: InteractiveInspectionReceipt['range'];
  if (raw.range !== undefined) {
    const r = raw.range;
    if (!object(r) || !keys(r, ['offset', 'returned', 'total', 'truncated']) || ![r.offset, r.returned, r.total].every(integer)
      || Number(r.returned) > (request.limit ?? 4000) || Number(r.offset) + Number(r.returned) > Number(r.total) || typeof r.truncated !== 'boolean'
      || r.offset !== (request.offset ?? 0) || r.truncated !== (Number(r.offset) + Number(r.returned) < Number(r.total))) return;
    range = { offset: Number(r.offset), returned: Number(r.returned), total: Number(r.total), truncated: r.truncated };
  }
  if ((request.view === 'metadata') === !!range) return;
  let stateSource: InteractiveInspectionReceipt['stateSource'];
  if (raw.stateSource !== undefined) {
    const s = raw.stateSource;
    if (!object(s) || !keys(s, ['kind', 'stateDigest', 'followupId', 'stateRevision', 'selectionDigest']) || !interactiveDigest(s.stateDigest)) return;
    if (s.kind === 'initial' && keys(s, ['kind', 'stateDigest']) && request.followupId === undefined) stateSource = { kind: 'initial', stateDigest: s.stateDigest };
    else if (s.kind === 'frozen-followup' && interactiveToken(s.followupId) && s.followupId === request.followupId
      && Number.isSafeInteger(s.stateRevision) && Number(s.stateRevision) >= 0 && interactiveDigest(s.selectionDigest)) stateSource = {
      kind: 'frozen-followup', followupId: s.followupId, stateRevision: Number(s.stateRevision), stateDigest: s.stateDigest, selectionDigest: s.selectionDigest };
    else return;
  }
  if ((request.view === 'evaluate') !== !!stateSource || (request.view === 'evaluate'
    ? typeof raw.computationTruncated !== 'boolean' : raw.computationTruncated !== undefined)) return;
  const result: InteractiveInspectionReceipt = { schemaVersion: 1, evidenceId: raw.evidenceId, owner, execution, conversationId: raw.conversationId,
    toolCallId: raw.toolCallId, specHash: raw.specHash, request, review: { verifierRunId: raw.review.verifierRunId,
      sourceRevision: raw.review.sourceRevision, targetsDigest: raw.review.targetsDigest }, ...(range ? { range } : {}), ...(stateSource ? { stateSource } : {}),
    ...(raw.computationTruncated !== undefined ? { computationTruncated: raw.computationTruncated } : {}), outputDigest: raw.outputDigest, observedAt: new Date(raw.observedAt).toISOString() };
  return new TextEncoder().encode(JSON.stringify(result)).byteLength <= 16 * 1024 ? result : undefined;
}
