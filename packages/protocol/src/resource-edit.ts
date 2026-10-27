import { normalizeResourceWindowRequest } from './resource-window.ts';
import type { BotDocumentReference } from './document-reference.ts';
import type { ResourceFeedbackRecipient, ResourceFeedbackPreparationIdentity } from './resource-feedback.ts';

/** Recoverable intent only. These records never grant filesystem access or prove execution. */
export interface ResourceEditTarget {
  readonly recipient: ResourceFeedbackRecipient;
  readonly reference: BotDocumentReference;
  readonly base: { readonly resourceId: string; readonly contentVersion: string };
}
export interface ResourceTextDraft {
  readonly id: string; readonly target: ResourceEditTarget;
  readonly baseText: string; readonly text: string; readonly revision: number;
  readonly createdAt: string; readonly updatedAt: string;
}
/** Host validates the real sender separately. A token cannot substitute for PermissionGrant. */
export interface ResourceEditWriter extends ResourceFeedbackPreparationIdentity { readonly token: string; readonly lease: number }
export interface ResourceEditReceipt {
  readonly outcome: 'applied' | 'conflict' | 'denied' | 'cancelled' | 'failed';
  readonly toolCallId?: string; readonly evidenceRef?: string; readonly observedVersion?: string;
}
export interface ResourceEditOperation {
  readonly requestId: string; readonly draftId: string; readonly draftRevision: number;
  readonly target: ResourceEditTarget; readonly providerId: string;
  readonly proposedVersion: string; readonly payloadHash: string;
  readonly createdAt: string; readonly updatedAt: string;
  readonly phase: 'prepared' | 'running' | 'uncertain' | 'settled';
  readonly hostEpoch?: string; readonly receipt?: ResourceEditReceipt;
}
export const RESOURCE_TEXT_DRAFT_LIMIT = 16;
export const RESOURCE_EDIT_OPERATION_LIMIT = 64;
export const RESOURCE_EDIT_TEXT_BYTES = 1024 * 1024;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]) => Object.keys(v).every(k => allowed.includes(k));
export const resourceEditToken = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(v) && !v.includes('..');
export const resourceEditDigest = (v: unknown): v is string => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const timestamp = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
const metadataText = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 2048 && !/[\u0000-\u001f]/.test(v);
export function validResourceEditText(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > RESOURCE_EDIT_TEXT_BYTES || v.includes('\u0000')) return false;
  for (let i = 0; i < v.length; i++) {
    const n = v.charCodeAt(i);
    if (n >= 0xd800 && n <= 0xdbff) { const next = v.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; }
    else if (n >= 0xdc00 && n <= 0xdfff) return false;
  }
  return new TextEncoder().encode(v).byteLength <= RESOURCE_EDIT_TEXT_BYTES;
}
export function normalizeResourceEditTarget(raw: unknown): ResourceEditTarget | undefined {
  if (!object(raw) || !keys(raw, ['recipient', 'reference', 'base']) || !object(raw.recipient)
    || !keys(raw.recipient, ['workspaceId', 'conversationId']) || !resourceEditToken(raw.recipient.workspaceId) || !resourceEditToken(raw.recipient.conversationId)
    || !object(raw.base) || !keys(raw.base, ['resourceId', 'contentVersion']) || !resourceEditDigest(raw.base.resourceId) || !resourceEditDigest(raw.base.contentVersion)) return;
  const normalized = normalizeResourceWindowRequest({ resource: { kind: 'document', mode: 'source', reference: raw.reference } });
  const reference = normalized?.resource.reference;
  if (!reference || reference.revision || reference.kind === 'directory' || reference.relativeTo !== undefined
    || reference.workspaceId !== raw.recipient.workspaceId || !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(reference.path)) return;
  if (reference.expectedObservation && (reference.expectedObservation.resourceId !== raw.base.resourceId
    || reference.expectedObservation.contentVersion !== undefined && reference.expectedObservation.contentVersion !== raw.base.contentVersion)) return;
  return { recipient: { workspaceId: raw.recipient.workspaceId, conversationId: raw.recipient.conversationId },
    reference: { ...reference, kind: 'file', expectedObservation: { resourceId: raw.base.resourceId, contentVersion: raw.base.contentVersion } },
    base: { resourceId: raw.base.resourceId, contentVersion: raw.base.contentVersion } };
}
export function normalizeResourceTextDraft(raw: unknown): ResourceTextDraft | undefined {
  if (!object(raw) || !keys(raw, ['id', 'target', 'baseText', 'text', 'revision', 'createdAt', 'updatedAt']) || !resourceEditToken(raw.id)
    || !validResourceEditText(raw.baseText) || !validResourceEditText(raw.text) || !integer(raw.revision) || !timestamp(raw.createdAt) || !timestamp(raw.updatedAt)) return;
  const target = normalizeResourceEditTarget(raw.target); if (!target) return;
  return { id: raw.id, target, baseText: raw.baseText, text: raw.text, revision: raw.revision,
    createdAt: new Date(raw.createdAt).toISOString(), updatedAt: new Date(raw.updatedAt).toISOString() };
}
export function normalizeResourceEditWriter(raw: unknown): ResourceEditWriter | undefined {
  if (!object(raw) || !keys(raw, ['viewId', 'windowId', 'generation', 'token', 'lease']) || !resourceEditToken(raw.viewId) || !resourceEditToken(raw.windowId)
    || !resourceEditToken(raw.token) || !integer(raw.lease) || raw.lease < 1
    || !(resourceEditToken(raw.generation) || integer(raw.generation) && raw.generation > 0)) return;
  return { viewId: raw.viewId, windowId: raw.windowId, generation: raw.generation, token: raw.token, lease: raw.lease };
}
export function normalizeResourceEditReceipt(raw: unknown): ResourceEditReceipt | undefined {
  if (!object(raw) || !keys(raw, ['outcome', 'toolCallId', 'evidenceRef', 'observedVersion'])
    || typeof raw.outcome !== 'string' || !['applied', 'conflict', 'denied', 'cancelled', 'failed'].includes(raw.outcome)
    || raw.toolCallId !== undefined && !metadataText(raw.toolCallId) || raw.evidenceRef !== undefined && !metadataText(raw.evidenceRef)
    || (raw.toolCallId === undefined) !== (raw.evidenceRef === undefined)
    || raw.observedVersion !== undefined && !resourceEditDigest(raw.observedVersion)
    || raw.outcome === 'applied' && (raw.toolCallId === undefined || raw.evidenceRef === undefined || raw.observedVersion === undefined)) return;
  return { outcome: raw.outcome as ResourceEditReceipt['outcome'], ...(raw.toolCallId !== undefined ? { toolCallId: raw.toolCallId as string, evidenceRef: raw.evidenceRef as string } : {}),
    ...(raw.observedVersion !== undefined ? { observedVersion: raw.observedVersion as string } : {}) };
}
export function normalizeResourceEditOperation(raw: unknown): ResourceEditOperation | undefined {
  if (!object(raw) || !keys(raw, ['requestId', 'draftId', 'draftRevision', 'target', 'providerId', 'proposedVersion', 'payloadHash', 'createdAt', 'updatedAt', 'phase', 'hostEpoch', 'receipt'])
    || !resourceEditToken(raw.requestId) || !resourceEditToken(raw.draftId) || !integer(raw.draftRevision) || !resourceEditToken(raw.providerId)
    || !resourceEditDigest(raw.proposedVersion) || !resourceEditDigest(raw.payloadHash) || !timestamp(raw.createdAt) || !timestamp(raw.updatedAt)
    || typeof raw.phase !== 'string' || !['prepared', 'running', 'uncertain', 'settled'].includes(raw.phase)
    || raw.hostEpoch !== undefined && !resourceEditToken(raw.hostEpoch)) return;
  const target = normalizeResourceEditTarget(raw.target), receipt = raw.receipt !== undefined ? normalizeResourceEditReceipt(raw.receipt) : undefined;
  if (!target || raw.receipt !== undefined && !receipt || (raw.phase === 'running' || raw.phase === 'uncertain') && raw.hostEpoch === undefined
    || raw.phase === 'prepared' && raw.hostEpoch !== undefined || (raw.phase === 'settled') !== !!receipt
    || receipt?.outcome === 'applied' && receipt.observedVersion !== raw.proposedVersion) return;
  return { requestId: raw.requestId, draftId: raw.draftId, draftRevision: raw.draftRevision, target, providerId: raw.providerId,
    proposedVersion: raw.proposedVersion, payloadHash: raw.payloadHash, createdAt: new Date(raw.createdAt).toISOString(), updatedAt: new Date(raw.updatedAt).toISOString(),
    phase: raw.phase as ResourceEditOperation['phase'], ...(raw.hostEpoch !== undefined ? { hostEpoch: raw.hostEpoch as string } : {}), ...(receipt ? { receipt } : {}) };
}

/** Retained text is a version, not current filesystem authority or task acceptance. */
export interface ResourceTextSnapshot {
  readonly id: string; readonly target: ResourceEditTarget; readonly version: string; readonly createdAt: string;
  readonly purpose: 'before' | 'after' | 'delivery'; readonly availability: 'retained' | 'cleaned';
  readonly evidenceRef: string; readonly toolCallId?: string; readonly operationId?: string; readonly artifactRef?: string;
}
export function normalizeResourceTextSnapshot(raw: unknown): ResourceTextSnapshot | undefined {
  if (!object(raw) || !keys(raw, ['id', 'target', 'version', 'createdAt', 'purpose', 'availability', 'evidenceRef', 'toolCallId', 'operationId', 'artifactRef'])
    || !resourceEditToken(raw.id) || !resourceEditDigest(raw.version) || !timestamp(raw.createdAt) || !metadataText(raw.evidenceRef)
    || !['before', 'after', 'delivery'].includes(raw.purpose as string) || !['retained', 'cleaned'].includes(raw.availability as string)
    || raw.toolCallId !== undefined && !metadataText(raw.toolCallId) || raw.operationId !== undefined && !resourceEditToken(raw.operationId)
    || raw.artifactRef !== undefined && !metadataText(raw.artifactRef)) return;
  const target = normalizeResourceEditTarget(raw.target);
  if (!target) return;
  if (raw.purpose === 'delivery' ? !metadataText(raw.artifactRef) || raw.operationId !== undefined || raw.version !== target.base.contentVersion
    : !resourceEditToken(raw.operationId) || !metadataText(raw.toolCallId) || raw.artifactRef !== undefined || raw.purpose === 'before' && raw.version !== target.base.contentVersion) return;
  return { id: raw.id, target, version: raw.version, createdAt: new Date(raw.createdAt).toISOString(), purpose: raw.purpose as ResourceTextSnapshot['purpose'],
    availability: raw.availability as ResourceTextSnapshot['availability'], evidenceRef: raw.evidenceRef,
    ...(raw.toolCallId !== undefined ? { toolCallId: raw.toolCallId as string } : {}), ...(raw.operationId !== undefined ? { operationId: raw.operationId as string } : {}),
    ...(raw.artifactRef !== undefined ? { artifactRef: raw.artifactRef as string } : {}) };
}

export type ResourceEditSource =
  | { readonly kind: 'document'; readonly reference: BotDocumentReference; readonly observed: ResourceEditTarget['base'] }
  | { readonly kind: 'native'; readonly identity: import('./resource-window.ts').ResourceWindowIdentity; readonly path?: string; readonly observed: ResourceEditTarget['base'] };
export interface ResourceEditViewHandle { readonly viewId: string; readonly windowId: string; readonly generation: number; readonly draftId: string }
export interface ResourceEditView { readonly handle: ResourceEditViewHandle; readonly draft: ResourceTextDraft }
export type ResourceEditResult<T extends object = Record<never, never>> = ({ readonly ok: true } & T) | { readonly ok: false; readonly code: string };
export interface ResourceEditScope { readonly workspaceId: string; readonly handle?: ResourceEditViewHandle }
export interface ResourceEditDraftInfo extends Omit<ResourceTextDraft, 'baseText' | 'text'> { readonly hasChanges: boolean }
export interface ResourceEditNotice { readonly workspaceId: string; readonly draftId?: string; readonly kind: 'writer' | 'saved' | 'discarded' | 'history' | 'operation'; readonly requestId?: string; readonly writerViewId?: string; readonly revision?: number }
export interface ResourceEditSaveReceipt { readonly draftId: string; readonly revision: number; readonly updatedAt: string; readonly textVersion: string }
export interface ResourceEditOperationRequest { readonly handle: ResourceEditViewHandle; readonly requestId: string }
export interface ResourceEditPermissionChallenge {
  readonly requestId: string; readonly challengeId: string; readonly argsDigest: string; readonly deadlineAt: string;
  readonly path: string; readonly expectedVersion: string; readonly proposedVersion: string; readonly reason: string; readonly confirmation?: string;
}
export interface ResourceEditOperationStatus {
  readonly operation: ResourceEditOperation; readonly live: boolean; readonly hostOwnedHere?: boolean; readonly hasActualResult: boolean;
  readonly governance: 'pending' | 'recorded' | 'unconfirmed' | 'unavailable'; readonly permission: ResourceEditPermissionChallenge | null;
  readonly permissionElsewhere?: boolean;
  readonly observation?: 'matches_proposed' | 'matches_base' | 'changed' | 'unavailable';
}
export interface ResourceEditsApi {
  readonly onChanged: (listener: (notice: ResourceEditNotice) => void) => () => void;
  readonly open: (request: { readonly requestId: string; readonly source: ResourceEditSource }) => Promise<ResourceEditResult<ResourceEditView>>;
  readonly resume: (request: { readonly requestId: string; readonly workspaceId: string; readonly draftId: string; readonly source?: ResourceEditSource }) => Promise<ResourceEditResult<ResourceEditView>>;
  readonly cancelOpen: (requestId: string) => Promise<ResourceEditResult>;
  readonly read: (handle: ResourceEditViewHandle) => Promise<ResourceEditResult<ResourceEditView>>;
  readonly acquire: (request: { readonly handle: ResourceEditViewHandle; readonly takeover?: boolean }) => Promise<ResourceEditResult<ResourceEditView & { readonly writer: ResourceEditWriter }>>;
  readonly save: (request: { readonly handle: ResourceEditViewHandle; readonly writer: ResourceEditWriter; readonly revision: number; readonly text: string }) => Promise<ResourceEditResult<{ readonly saved: ResourceEditSaveReceipt }>>;
  readonly discard: (request: { readonly handle: ResourceEditViewHandle; readonly writer: ResourceEditWriter; readonly revision: number }) => Promise<ResourceEditResult>;
  readonly close: (handle: ResourceEditViewHandle) => Promise<ResourceEditResult>;
  readonly list: (request: ResourceEditScope & { readonly cursor?: string; readonly limit?: number }) => Promise<ResourceEditResult<{ readonly drafts: readonly ResourceEditDraftInfo[]; readonly operations: readonly ResourceEditOperation[]; readonly nextCursor: string | null; readonly staleCount: number }>>;
  readonly history: (request: ResourceEditScope & { readonly cursor?: string; readonly limit?: number }) => Promise<ResourceEditResult<{ readonly items: readonly ResourceTextSnapshot[]; readonly nextCursor: string | null; readonly unavailableCount: number }>>;
  readonly readSnapshot: (request: ResourceEditScope & { readonly id: string }) => Promise<ResourceEditResult<{ readonly snapshot: ResourceTextSnapshot; readonly content: string }>>;
  readonly cleanup: (request: ResourceEditScope & { readonly requestIds: readonly string[] }) => Promise<ResourceEditResult<{ readonly removedBytes: number }>>;
  readonly archive: (request: ResourceEditScope & { readonly requestId: string }) => Promise<ResourceEditResult>;
  readonly clearDelivery: (request: ResourceEditScope & { readonly id: string }) => Promise<ResourceEditResult<{ readonly removedBytes: number }>>;
  readonly submit: (request: ResourceEditOperationRequest & { readonly writer: ResourceEditWriter; readonly revision: number }) => Promise<ResourceEditResult<ResourceEditOperationStatus>>;
  readonly continueSubmission: (request: ResourceEditOperationRequest) => Promise<ResourceEditResult<ResourceEditOperationStatus>>;
  readonly operationStatus: (request: ResourceEditOperationRequest) => Promise<ResourceEditResult<ResourceEditOperationStatus>>;
  readonly reconcileSubmission: (request: ResourceEditOperationRequest) => Promise<ResourceEditResult<ResourceEditOperationStatus>>;
  readonly cancelSubmission: (request: ResourceEditOperationRequest) => Promise<ResourceEditResult<ResourceEditOperationStatus>>;
  readonly decideSubmissionPermission: (request: ResourceEditOperationRequest & { readonly challengeId: string; readonly argsDigest: string; readonly allow: boolean }) => Promise<ResourceEditResult>;
  readonly readExecution: (request: ResourceEditOperationRequest) => Promise<ResourceEditResult<{ readonly record: import('./resource-edit-execution.ts').ResourceEditExecutionRecord; readonly postlude: import('./resource-edit-execution.ts').ResourceEditPostlude | null }>>;
  readonly readSubmission: (request: ResourceEditOperationRequest) => Promise<ResourceEditResult<{ readonly operation: ResourceEditOperation; readonly baseText: string; readonly text: string }>>;
}
export function normalizeResourceEditSource(raw: unknown): ResourceEditSource | undefined {
  if (!object(raw) || !object(raw.observed) || !keys(raw.observed, ['resourceId', 'contentVersion'])
    || !resourceEditDigest(raw.observed.resourceId) || !resourceEditDigest(raw.observed.contentVersion)) return;
  const observed = { resourceId: raw.observed.resourceId, contentVersion: raw.observed.contentVersion };
  if (raw.kind === 'document') {
    if (!keys(raw, ['kind', 'reference', 'observed'])) return;
    const normalized = normalizeResourceWindowRequest({ resource: { kind: 'document', mode: 'source', reference: raw.reference } });
    const reference = normalized?.resource.reference;
    if (!reference || reference.kind === 'directory' || reference.revision || reference.expectedObservation
      && (reference.expectedObservation.resourceId !== observed.resourceId || reference.expectedObservation.contentVersion !== undefined && reference.expectedObservation.contentVersion !== observed.contentVersion)) return;
    return { kind: 'document', reference: { ...reference, kind: 'file', expectedObservation: observed }, observed };
  }
  if (raw.kind !== 'native' || !keys(raw, ['kind', 'identity', 'path', 'observed']) || !object(raw.identity)
    || !keys(raw.identity, ['viewId', 'windowId', 'generation']) || !resourceEditToken(raw.identity.viewId) || !resourceEditToken(raw.identity.windowId)
    || !integer(raw.identity.generation) || raw.identity.generation < 1
    || raw.path !== undefined && (typeof raw.path !== 'string' || raw.path.length > 8192 || /[\u0000-\u001f]/.test(raw.path) || !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(raw.path))) return;
  return { kind: 'native', identity: { viewId: raw.identity.viewId, windowId: raw.identity.windowId, generation: raw.identity.generation }, observed,
    ...(typeof raw.path === 'string' ? { path: raw.path } : {}) };
}
export function normalizeResourceEditHandle(raw: unknown): ResourceEditViewHandle | undefined {
  if (!object(raw) || !keys(raw, ['viewId', 'windowId', 'generation', 'draftId']) || !resourceEditToken(raw.viewId) || !resourceEditToken(raw.windowId) || !resourceEditToken(raw.draftId)
    || !integer(raw.generation) || raw.generation < 1) return;
  return { viewId: raw.viewId, windowId: raw.windowId, generation: raw.generation, draftId: raw.draftId };
}
