import type { BotDocumentReference, LocalDocumentReadResult } from './document-reference.ts';
import type { EvidenceDeliveryBinding } from './evidence-inspection.ts';

/** Read-only presentation. None of these fields grant access or identify a browser guest/writer. */
export type ResourceWindowResource =
  | ({ readonly kind: 'document'; readonly reference: BotDocumentReference; readonly line?: number; readonly delivery?: EvidenceDeliveryBinding }
    & ({ readonly mode: 'preview' | 'source' } | { readonly mode: 'diff'; readonly comparison: 'working' | 'staged' }))
  | { readonly kind: 'directory'; readonly reference: BotDocumentReference }
  | { readonly kind: 'comparison'; readonly reference: BotDocumentReference; readonly fromRef: string; readonly toRef?: string; readonly comparison?: 'working' | 'staged' };
export interface ResourceWindowNavigation {
  readonly top: number;
  readonly left: number;
  readonly selected?: string;
  readonly expanded?: readonly string[];
  readonly filter?: string;
  readonly mode?: 'preview' | 'source';
  readonly positions?: readonly { readonly key: string; readonly top: number; readonly left: number }[];
}
export interface ResourceWindowOpenRequest {
  readonly resource: ResourceWindowResource;
  readonly sourceTabId?: string;
  readonly navigation?: ResourceWindowNavigation;
}
export interface ResourceWindowOwner {
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly task?: BotDocumentReference['task'];
}
export interface ResourceWindowIdentity { readonly viewId: string; readonly windowId: string; readonly generation: number }
export interface ResourceWindowContext extends ResourceWindowIdentity {
  readonly owner: ResourceWindowOwner;
  readonly resource: ResourceWindowResource;
  readonly sourceTabId?: string;
  readonly navigation?: ResourceWindowNavigation;
  readonly sourceNavigation?: ResourceWindowNavigation;
  readonly navigationVersion?: number;
  readonly phase: 'prepared' | 'attached' | 'ready';
}
export type ResourceWindowStatus = 'invalid_request' | 'scope_denied' | 'permission_denied' | 'not_found' | 'workspace_unavailable' | 'revision_unavailable' | 'source_unavailable' | 'source_changed' | 'storage_unavailable' | 'limit_reached' | 'stale_view' | 'not_ready' | 'cancelled' | 'disposed';
export type ResourceWindowResult = { readonly ok: true; readonly context: ResourceWindowContext; readonly persisted?: boolean; readonly returnStatus?: 'returned' | 'source_tab_closed' } | { readonly ok: false; readonly status: ResourceWindowStatus };
export interface ResourceWindowReturnRequest { readonly requestId: string; readonly context: ResourceWindowContext; readonly expiresAt: number }
export interface ResourceWindowReturnAck { readonly requestId: string; readonly identity: ResourceWindowIdentity; readonly status: 'returned' | 'source_tab_closed' | 'cancelled' }
export interface ResourceWindowCheckpointRequest { readonly requestId: string; readonly identity: ResourceWindowIdentity }
export interface ResourceWindowCheckpointAck extends ResourceWindowCheckpointRequest { readonly status: 'confirmed' | 'blocked' }
export interface ResourceWindowCloseBlocked { readonly identity: ResourceWindowIdentity; readonly reason: 'save_failed' | 'unconfirmed' }
export interface ResourceWindowHistoryEntry { readonly id: string; readonly owner: ResourceWindowOwner; readonly request: ResourceWindowOpenRequest; readonly savedAt: string }
export interface ResourceWindowHistoryResult { readonly ok: boolean; readonly status: 'ok' | 'scope_denied' | 'storage_unavailable'; readonly entries: readonly ResourceWindowHistoryEntry[] }

/** The host supplies owner, task, revision and allowed root from its lease, never from this request. */
export interface ResourceWindowReadRequest {
  readonly identity: ResourceWindowIdentity;
  readonly operation: 'content' | 'directory' | 'diff';
  /** Directory descendants only. Omitted for the originally bound resource. */
  readonly path?: string;
  readonly expectedObservation?: BotDocumentReference['expectedObservation'];
  readonly loadCurrent?: boolean;
}
export interface ResourceWindowReadResult {
  readonly ok: boolean;
  readonly status: string;
  readonly document?: LocalDocumentReadResult & { readonly dataUrl?: string; readonly media: 'text' | 'image' };
  readonly directory?: { readonly entries: readonly { readonly name: string; readonly isDir: boolean; readonly absPath: string }[]; readonly truncated?: boolean };
  readonly diff?: { readonly diffText: string; readonly fromRef?: string; readonly toRef?: string; readonly untracked?: readonly string[]; readonly untrackedTruncated?: boolean };
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
const token = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value) && !value.includes('..');
const text = (value: unknown, max: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= max && !/[\u0000-\u001f]/.test(value);
const point = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10_000_000;
function reference(raw: unknown): BotDocumentReference | undefined {
  if (!object(raw) || !keys(raw, ['workspaceId', 'path', 'relativeTo', 'task', 'kind', 'expectedObservation', 'revision']) || !token(raw.workspaceId) || !text(raw.path, 8192)) return;
  if (raw.kind !== undefined && raw.kind !== 'file' && raw.kind !== 'directory' || raw.relativeTo !== undefined && !text(raw.relativeTo, 8192)) return;
  let task: BotDocumentReference['task'], expectedObservation: BotDocumentReference['expectedObservation'], revision: BotDocumentReference['revision'];
  if (raw.task !== undefined) {
    if (!object(raw.task) || !keys(raw.task, ['sessionId', 'planId']) || !token(raw.task.sessionId) || !token(raw.task.planId)) return;
    task = { sessionId: raw.task.sessionId, planId: raw.task.planId };
  }
  if (raw.expectedObservation !== undefined) {
    const e = raw.expectedObservation;
    if (!object(e) || !keys(e, ['resourceId', 'contentVersion']) || (typeof e.resourceId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(e.resourceId))
      || e.contentVersion !== undefined && (typeof e.contentVersion !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(e.contentVersion))) return;
    expectedObservation = { resourceId: e.resourceId, ...(typeof e.contentVersion === 'string' ? { contentVersion: e.contentVersion } : {}) };
  }
  if (raw.revision !== undefined) {
    const r = raw.revision;
    if (!object(r) || !keys(r, ['kind', 'commit', 'repositoryId']) || r.kind !== 'git' || typeof r.commit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(r.commit)
      || r.repositoryId !== undefined && !text(r.repositoryId, 1024)) return;
    revision = { kind: 'git', commit: r.commit, ...(typeof r.repositoryId === 'string' ? { repositoryId: r.repositoryId } : {}) };
  }
  return { workspaceId: raw.workspaceId, path: raw.path, ...(raw.kind ? { kind: raw.kind } : {}),
    ...(typeof raw.relativeTo === 'string' ? { relativeTo: raw.relativeTo } : {}), ...(task ? { task } : {}), ...(expectedObservation ? { expectedObservation } : {}), ...(revision ? { revision } : {}) };
}
function resource(raw: unknown): ResourceWindowResource | undefined {
  if (!object(raw)) return;
  const ref = reference(raw.reference); if (!ref) return;
  if (raw.kind === 'directory') {
    if (!keys(raw, ['kind', 'reference']) || ref.revision || ref.expectedObservation) return;
    return { kind: 'directory', reference: { ...ref, kind: 'directory' } };
  }
  if (raw.kind === 'comparison') {
    if (!keys(raw, ['kind', 'reference', 'fromRef', 'toRef', 'comparison']) || ref.revision || ref.expectedObservation || !text(raw.fromRef, 256)
      || raw.toRef !== undefined && !text(raw.toRef, 256) || raw.comparison !== undefined && (typeof raw.comparison !== 'string' || !['working', 'staged'].includes(raw.comparison))) return;
    // A working/index comparison cannot silently discard a supplied immutable endpoint.
    if (raw.comparison && (raw.fromRef !== 'HEAD' || raw.toRef !== undefined)) return;
    if (!raw.comparison && (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(raw.fromRef)
      || typeof raw.toRef === 'string' && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(raw.toRef))) return;
    return { kind: 'comparison', reference: { ...ref, kind: 'directory' }, fromRef: raw.fromRef,
      ...(typeof raw.toRef === 'string' ? { toRef: raw.toRef } : {}), ...(raw.comparison ? { comparison: raw.comparison as 'working' | 'staged' } : {}) };
  }
  if (raw.kind !== 'document' || !keys(raw, ['kind', 'reference', 'mode', 'comparison', 'line', 'delivery']) || ref.kind === 'directory'
    || typeof raw.mode !== 'string' || !['preview', 'source', 'diff'].includes(raw.mode) || ref.revision && raw.mode === 'diff'
    || raw.mode === 'diff' && raw.comparison === undefined
    || raw.comparison !== undefined && (raw.mode !== 'diff' || typeof raw.comparison !== 'string' || !['working', 'staged'].includes(raw.comparison))
    || raw.line !== undefined && (!Number.isSafeInteger(raw.line) || Number(raw.line) < 1 || Number(raw.line) > 1_000_000)) return;
  let delivery: EvidenceDeliveryBinding | undefined;
  if (raw.delivery !== undefined) {
    const d = raw.delivery;
    if (ref.revision || !object(d) || !keys(d, ['evidenceRef', 'artifactRef']) || !text(d.evidenceRef, 500) || /[\s\\]/.test(d.evidenceRef) || d.evidenceRef.includes('..') || !text(d.artifactRef, 8192)) return;
    delivery = { evidenceRef: d.evidenceRef, artifactRef: d.artifactRef };
  }
  const common = { kind: 'document' as const, reference: { ...ref, kind: 'file' as const },
    ...(typeof raw.line === 'number' ? { line: raw.line } : {}), ...(delivery ? { delivery } : {}) };
  return raw.mode === 'diff' ? { ...common, mode: 'diff', comparison: raw.comparison as 'working' | 'staged' }
    : { ...common, mode: raw.mode as 'preview' | 'source' };
}
/** Only bounded hints for this kind of view; never accept a body, permission, browser instance or draft. */
export function normalizeResourceWindowNavigation(raw: unknown, kind: ResourceWindowResource['kind']): ResourceWindowNavigation | undefined {
  if (!object(raw) || !keys(raw, kind === 'directory' ? ['top', 'left', 'selected', 'expanded', 'filter'] : kind === 'comparison' ? ['top', 'left', 'selected', 'positions'] : ['top', 'left', 'mode', 'positions']) || !point(raw.top) || !point(raw.left)) return;
  if (raw.selected !== undefined && !text(raw.selected, 8192) || raw.filter !== undefined && (typeof raw.filter !== 'string' || raw.filter.length > 256 || /[\u0000-\u001f]/.test(raw.filter))
    || raw.expanded !== undefined && (!Array.isArray(raw.expanded) || raw.expanded.length > 64 || !raw.expanded.every(value => text(value, 8192)))) return;
  if (raw.mode !== undefined && raw.mode !== 'preview' && raw.mode !== 'source') return;
  const relative = (value: unknown) => text(value, 4096) && (value === '.' || !/^[\\/]/.test(value) && value.split('/').length <= 16 && value.split('/').every(part => part && part !== '.' && part !== '..' && !/[\\:]/.test(part)));
  if (kind === 'directory' && (raw.selected !== undefined && !relative(raw.selected)
    || Array.isArray(raw.expanded) && !raw.expanded.every(relative))) return;
  if (raw.positions !== undefined && (!Array.isArray(raw.positions) || raw.positions.length > 12 || !raw.positions.every(value => object(value) && keys(value, ['key', 'top', 'left']) && text(value.key, 8192) && point(value.top) && point(value.left)
    && (kind !== 'document' || ['preview', 'source', 'diff'].includes(value.key as string))))) return;
  if (Array.isArray(raw.positions) && new Set(raw.positions.map(value => value.key)).size !== raw.positions.length) return;
  return { top: raw.top, left: raw.left, ...(typeof raw.selected === 'string' ? { selected: raw.selected } : {}),
    ...(typeof raw.filter === 'string' ? { filter: raw.filter } : {}), ...(Array.isArray(raw.expanded) ? { expanded: [...new Set(raw.expanded as string[])] } : {}),
    ...(raw.mode ? { mode: raw.mode as 'preview' | 'source' } : {}), ...(Array.isArray(raw.positions) ? { positions: raw.positions.map(value => ({ key: value.key, top: value.top, left: value.left })) } : {}) };
}
export function normalizeResourceWindowRequest(raw: unknown): ResourceWindowOpenRequest | undefined {
  if (!object(raw) || !keys(raw, ['resource', 'sourceTabId', 'navigation']) || raw.sourceTabId !== undefined && !token(raw.sourceTabId)) return;
  const target = resource(raw.resource); if (!target) return;
  const navigation = raw.navigation === undefined ? undefined : normalizeResourceWindowNavigation(raw.navigation, target.kind);
  if (raw.navigation !== undefined && !navigation) return;
  return { resource: target, ...(typeof raw.sourceTabId === 'string' ? { sourceTabId: raw.sourceTabId } : {}), ...(navigation ? { navigation } : {}) };
}
export function normalizeResourceWindowOwner(raw: unknown): ResourceWindowOwner | undefined {
  if (!object(raw) || !keys(raw, ['workspaceId', 'conversationId', 'task']) || !token(raw.workspaceId) || !token(raw.conversationId)) return;
  if (raw.task !== undefined && (!object(raw.task) || !keys(raw.task, ['sessionId', 'planId']) || !token(raw.task.sessionId) || !token(raw.task.planId))) return;
  return { workspaceId: raw.workspaceId, conversationId: raw.conversationId,
    ...(object(raw.task) ? { task: { sessionId: raw.task.sessionId as string, planId: raw.task.planId as string } } : {}) };
}
