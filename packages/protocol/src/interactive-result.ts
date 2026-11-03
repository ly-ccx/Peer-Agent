import type { DataLevel } from './index.ts';
import type { SessionExecutionIdentity } from './session-control.ts';

/** Host-neutral content and presentation contracts. References never grant access. */
export type InteractiveJSON = null | boolean | number | string | readonly InteractiveJSON[] | { readonly [key: string]: InteractiveJSON };
export interface InteractiveOwner { readonly workspaceId: string; readonly conversationId: string }
export interface InteractiveResultReference { readonly owner: InteractiveOwner; readonly resultId: string; readonly contentVersion: string }
export interface InteractivePublicationCallReference { readonly owner: InteractiveOwner; readonly conversationId: string; readonly toolCallId: string }
export type InteractivePublicationIntent = { readonly kind: 'create' } | { readonly kind: 'revise'; readonly base: InteractiveResultReference };
export type AdmittedMaterialReference =
  | { readonly kind: 'tool-result'; readonly conversationId: string; readonly toolCallId: string; readonly expectedContentVersion: string }
  | { readonly kind: 'user-material'; readonly messageId: string; readonly attachmentId: string; readonly expectedContentVersion: string }
  | { readonly kind: 'model-data'; readonly value: InteractiveJSON };
export interface BoundedDataSelector {
  readonly path?: readonly string[];
  readonly fields?: readonly string[];
  readonly start?: number;
  readonly limit?: number;
}
export interface InteractiveInputBinding { readonly bindingId: string; readonly source: AdmittedMaterialReference; readonly selector?: BoundedDataSelector }
export interface InteractiveMaterialNotice {
  readonly source: Exclude<AdmittedMaterialReference, { readonly kind: 'model-data' }>;
  readonly format: 'peer-tool-observation-1' | 'peer-user-upload-1';
  readonly selectorRoots: readonly string[];
  readonly dataLevel: DataLevel;
  readonly truncated: boolean;
  readonly redacted: boolean;
}
/** Host-only Provider observation, attached non-enumerably to its actual Tool Result. */
export interface CanonicalToolMaterialObservation {
  readonly schemaVersion: 1;
  readonly toolCallId: string;
  readonly capabilityId: string;
  readonly evidenceId: string;
  readonly payload: InteractiveJSON;
}
export interface InteractiveResultDraft {
  readonly publication: InteractivePublicationIntent;
  readonly title: string;
  readonly textFallback: string;
  readonly program: string;
  readonly inputs: readonly InteractiveInputBinding[];
}
export interface InteractiveMaterialProvenance {
  readonly bindingId: string;
  readonly source: Exclude<AdmittedMaterialReference, { readonly kind: 'model-data' }> | { readonly kind: 'model-data'; readonly contentDigest: string };
  readonly contentVersion: string;
  readonly selectedDigest: string;
  readonly selector?: BoundedDataSelector;
  readonly observedAt: string;
  readonly capturedAt: string;
  readonly truncated: boolean;
  readonly redacted: boolean;
  readonly dataLevel: DataLevel;
  readonly evidenceRefs: readonly string[];
}
export type InteractiveStateValue = string | number | boolean;
export interface InteractiveStateField { readonly type: 'string' | 'number' | 'boolean'; readonly min?: number; readonly max?: number; readonly options?: readonly string[] }
export type InteractiveStateSchema = Readonly<Record<string, InteractiveStateField>>;
export type InteractiveStateValues = Readonly<Record<string, InteractiveStateValue>>;
export interface InteractiveStateSnapshot {
  readonly result: InteractiveResultReference;
  readonly specHash: string;
  readonly stateSchemaHash: string;
  readonly stateRevision: number;
  readonly values: InteractiveStateValues;
  readonly inputDrafts: Readonly<Record<string, string>>;
  readonly stateDigest: string;
  readonly updatedAt: string;
  readonly requestId: string;
}
export interface InteractiveElement {
  readonly type: 'element'; readonly typeName: string; readonly statementId?: string; readonly stateTarget?: string;
  readonly props: Readonly<Record<string, unknown>>;
}
export interface InteractiveContent {
  readonly schemaVersion: 1;
  readonly engine: string;
  readonly libraryVersion: string;
  readonly specHash: string;
  readonly title: string;
  readonly textFallback: string;
  readonly program: string;
  readonly bindings: Readonly<Record<string, InteractiveJSON>>;
  readonly initialValues: InteractiveStateValues;
  readonly stateSchema: InteractiveStateSchema;
  readonly stateSchemaHash: string;
  readonly numberPolicy: string;
  readonly tree?: InteractiveElement;
}
export interface InteractivePublishedResult {
  readonly reference: InteractiveResultReference;
  readonly content: InteractiveContent;
  readonly source: SessionExecutionIdentity & { readonly conversationId: string; readonly workId?: string; readonly toolCallId: string };
  readonly provenance: readonly InteractiveMaterialProvenance[];
  readonly predecessor?: InteractiveResultReference;
  readonly evidenceRef: string;
  readonly artifactRef: string;
  readonly dataLevel: InteractiveMaterialProvenance['dataLevel'];
  readonly createdAt: string;
}
export interface InteractivePublicationPermissionScope {
  readonly kind: 'interactive-result';
  readonly capabilityId: typeof INTERACTIVE_PUBLISH_CAPABILITY;
  readonly owner: InteractiveOwner;
  readonly source: InteractivePublishedResult['source'];
  readonly parameterDigest: string;
}
export interface InteractiveUserArtifact {
  readonly kind: 'interactive';
  readonly ref: string;
  readonly label: string;
  readonly reference: InteractiveResultReference;
  readonly specHash: string;
}
export type InteractivePublicationStatus = 'not_committed' | 'index_pending' | 'published' | 'unknown';
export interface InteractiveInspectRequest {
  readonly target: { readonly kind: 'result'; readonly reference: InteractiveResultReference }
    | { readonly kind: 'publication'; readonly reference: InteractivePublicationCallReference };
  readonly view: 'metadata' | 'text' | 'program' | 'data' | 'evaluate';
  readonly bindingId?: string;
  readonly selector?: BoundedDataSelector;
  /** Only an explicitly admitted, immutable user selection; never the latest mutable state. */
  readonly followupId?: string;
  readonly offset?: number;
  readonly limit?: number;
}
export interface InteractiveViewHandle { readonly viewId: string; readonly windowId: string; readonly generation: string }
export interface InteractiveWriter { readonly viewId: string; readonly generation: string; readonly token: string }
export interface InteractiveFollowup {
  readonly followupId: string;
  readonly recipient: InteractiveOwner;
  readonly result: InteractiveResultReference;
  readonly specHash: string;
  readonly stateRevision: number;
  readonly stateDigest: string;
  readonly selectionDigest: string;
  readonly values: InteractiveStateValues;
  readonly dataLevel: DataLevel;
  readonly capturedAt: string;
  readonly excerpt: string;
}
export type InteractiveResult<T extends object = Record<never, never>> = ({ readonly ok: true } & T) | { readonly ok: false; readonly code: string };
export interface InteractiveOpenView {
  readonly handle: InteractiveViewHandle;
  readonly result: InteractivePublishedResult;
  readonly state: InteractiveStateSnapshot;
}
export interface InteractiveResultsApi {
  open(request: { readonly reference: InteractiveResultReference; readonly requestId: string }): Promise<InteractiveResult<InteractiveOpenView>>;
  readState(request: { readonly handle: InteractiveViewHandle }): Promise<InteractiveResult<{ readonly state: InteractiveStateSnapshot }>>;
  acquire(request: { readonly handle: InteractiveViewHandle; readonly expectedRevision: number; readonly takeover?: boolean }): Promise<InteractiveResult<{ readonly writer: InteractiveWriter }>>;
  save(request: { readonly handle: InteractiveViewHandle; readonly writer: InteractiveWriter; readonly expectedRevision: number; readonly requestId: string; readonly values: InteractiveStateValues; readonly inputDrafts: Readonly<Record<string, string>> }): Promise<InteractiveResult<{ readonly state: InteractiveStateSnapshot }>>;
  release(request: { readonly handle: InteractiveViewHandle; readonly writer?: InteractiveWriter }): Promise<InteractiveResult>;
  prepareFollowup(request: { readonly handle: InteractiveViewHandle; readonly stateRevision: number; readonly stateDigest: string; readonly fields: readonly string[]; readonly requestId: string }): Promise<InteractiveResult<{ readonly followup: InteractiveFollowup }>>;
}

export const INTERACTIVE_PUBLISH_CAPABILITY = 'local.interactive.publish';
export const INTERACTIVE_INSPECT_CAPABILITY = 'local.interactive.inspect';
export const INTERACTIVE_PUBLISH_TOOL = 'publish_interactive_result';
export const INTERACTIVE_INSPECT_TOOL = 'inspect_interactive_result';
export const INTERACTIVE_RESULT_SCHEMA_VERSION = 1;
export const INTERACTIVE_RESULT_LIMITS = Object.freeze({
  programBytes: 64 * 1024, fallbackBytes: 32 * 1024, inputBytes: 512 * 1024, bindings: 16,
  astNodes: 1000, astDepth: 24, expandedNodes: 300, expandedDepth: 12, stateFields: 64,
  stateBytes: 64 * 1024, collectionItems: 500, textChars: 8192, tablePageRows: 100,
  tablePageCells: 1000, chartSeries: 6, chartPoints: 500, evaluationSteps: 40_000,
  workerTimeoutMs: 2000, resultsPerBot: 256, storeBytes: 128 * 1024 * 1024,
  manifestBytes: 2 * 1024 * 1024, contentRepairs: 2,
});
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v))
  && Object.values(Object.getOwnPropertyDescriptors(v)).every(d => 'value' in d);
const keys = (v: Record<string, unknown>, allowed: readonly string[]) => Object.keys(v).every(key => allowed.includes(key));
const safeKey = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v) && !['constructor', 'prototype', '__proto__'].includes(v);
export const interactiveBindingId = safeKey;
export const interactiveToken = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(v) && !v.includes('..');
export const interactiveDigest = (v: unknown): v is string => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v);
export function normalizeInteractiveMaterialNotice(raw: unknown): InteractiveMaterialNotice | undefined {
  if (!object(raw) || !keys(raw, ['source', 'format', 'selectorRoots', 'dataLevel', 'truncated', 'redacted']) || !object(raw.source)
    || !interactiveDigest(raw.source.expectedContentVersion) || typeof raw.truncated !== 'boolean' || typeof raw.redacted !== 'boolean'
    || !['D0_public', 'D1_internal', 'D2_sensitive', 'D3_private', 'D4_regulated'].includes(raw.dataLevel as string)) return;
  const source = raw.source;
  let admitted: InteractiveMaterialNotice['source'];
  if (source.kind === 'tool-result' && raw.format === 'peer-tool-observation-1' && keys(source, ['kind', 'conversationId', 'toolCallId', 'expectedContentVersion'])
    && interactiveToken(source.conversationId) && interactiveToken(source.toolCallId)) admitted = { kind: source.kind, conversationId: source.conversationId, toolCallId: source.toolCallId, expectedContentVersion: source.expectedContentVersion as string };
  else if (source.kind === 'user-material' && raw.format === 'peer-user-upload-1' && keys(source, ['kind', 'messageId', 'attachmentId', 'expectedContentVersion'])
    && interactiveToken(source.messageId) && interactiveToken(source.attachmentId)) admitted = { kind: source.kind, messageId: source.messageId, attachmentId: source.attachmentId, expectedContentVersion: source.expectedContentVersion as string };
  else return;
  const roots = raw.selectorRoots, allowed = source.kind === 'tool-result' ? ['payload', 'json'] : ['text', 'json'];
  if (!Array.isArray(roots) || !roots.length || roots.length > 2 || roots.some(value => !allowed.includes(value)) || new Set(roots).size !== roots.length) return;
  return { source: admitted, format: raw.format as InteractiveMaterialNotice['format'], selectorRoots: [...roots],
    dataLevel: raw.dataLevel as DataLevel, truncated: raw.truncated, redacted: raw.redacted };
}
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
const bytes = (v: string) => new TextEncoder().encode(v).byteLength;
const text = (v: unknown, max: number): v is string => typeof v === 'string' && !!v.trim() && !v.includes('\0') && bytes(v) <= max;
export function normalizeInteractiveOwner(raw: unknown): InteractiveOwner | undefined {
  if (!object(raw) || !keys(raw, ['workspaceId', 'conversationId']) || !interactiveToken(raw.workspaceId) || !interactiveToken(raw.conversationId)) return;
  return { workspaceId: raw.workspaceId, conversationId: raw.conversationId };
}
export function normalizeInteractiveReference(raw: unknown): InteractiveResultReference | undefined {
  if (!object(raw) || !keys(raw, ['owner', 'resultId', 'contentVersion']) || !interactiveToken(raw.resultId) || !interactiveDigest(raw.contentVersion)) return;
  const owner = normalizeInteractiveOwner(raw.owner);
  return owner ? { owner, resultId: raw.resultId, contentVersion: raw.contentVersion } : undefined;
}
export function normalizeInteractivePublicationReference(raw: unknown): InteractivePublicationCallReference | undefined {
  if (!object(raw) || !keys(raw, ['owner', 'conversationId', 'toolCallId']) || !interactiveToken(raw.conversationId) || !interactiveToken(raw.toolCallId)) return;
  const owner = normalizeInteractiveOwner(raw.owner);
  return owner ? { owner, conversationId: raw.conversationId, toolCallId: raw.toolCallId } : undefined;
}
export function normalizeInteractiveSelector(raw: unknown): BoundedDataSelector | undefined {
  if (!object(raw) || !keys(raw, ['path', 'fields', 'start', 'limit'])) return;
  for (const field of ['path', 'fields'] as const) if (raw[field] !== undefined && (!Array.isArray(raw[field]) || raw[field].length > (field === 'path' ? 8 : 32)
    || !raw[field].every(safeKey) || new Set(raw[field]).size !== raw[field].length)) return;
  if (raw.start !== undefined && !integer(raw.start, 0, 500) || raw.limit !== undefined && !integer(raw.limit, 1, 500)) return;
  return { ...(raw.path ? { path: [...raw.path as string[]] } : {}), ...(raw.fields ? { fields: [...raw.fields as string[]] } : {}),
    ...(raw.start !== undefined ? { start: raw.start as number } : {}), ...(raw.limit !== undefined ? { limit: raw.limit as number } : {}) };
}
function jsonValue(raw: unknown, depth = 0, active = new Set<object>(), budget = { nodes: 0 }): raw is InteractiveJSON {
  if (depth > 16 || ++budget.nodes > INTERACTIVE_RESULT_LIMITS.evaluationSteps) return false;
  if (raw === null || typeof raw === 'boolean' || typeof raw === 'string' && raw.length <= 8192 || typeof raw === 'number' && Number.isFinite(raw)) return true;
  if (!raw || typeof raw !== 'object' || active.has(raw)) return false;
  active.add(raw);
  const valid = Array.isArray(raw) ? raw.length <= 500 && raw.every(value => jsonValue(value, depth + 1, active, budget))
    : object(raw) && Object.keys(raw).length <= 500 && Object.entries(raw).every(([key, value]) => !['__proto__', 'constructor', 'prototype'].includes(key) && jsonValue(value, depth + 1, active, budget));
  active.delete(raw);
  return valid;
}
export function normalizeInteractiveDraft(raw: unknown): InteractiveResultDraft | undefined {
  if (!object(raw) || !keys(raw, ['publication', 'title', 'textFallback', 'program', 'inputs'])
    || !text(raw.title, 640) || raw.title.length > 160 || !text(raw.textFallback, INTERACTIVE_RESULT_LIMITS.fallbackBytes)
    || !text(raw.program, INTERACTIVE_RESULT_LIMITS.programBytes) || !object(raw.publication)
    || !Array.isArray(raw.inputs) || raw.inputs.length > INTERACTIVE_RESULT_LIMITS.bindings) return;
  let publication: InteractivePublicationIntent;
  if (raw.publication.kind === 'create' && keys(raw.publication, ['kind'])) publication = { kind: 'create' };
  else if (raw.publication.kind === 'revise' && keys(raw.publication, ['kind', 'base'])) {
    const base = normalizeInteractiveReference(raw.publication.base); if (!base) return;
    publication = { kind: 'revise', base };
  } else return;
  const inputs: InteractiveInputBinding[] = [];
  for (const binding of raw.inputs) {
    if (!object(binding) || !keys(binding, ['bindingId', 'source', 'selector']) || !safeKey(binding.bindingId) || !object(binding.source)) return;
    const s = binding.source;
    let source: AdmittedMaterialReference;
    if (s.kind === 'tool-result' && keys(s, ['kind', 'conversationId', 'toolCallId', 'expectedContentVersion'])
      && interactiveToken(s.conversationId) && interactiveToken(s.toolCallId) && interactiveDigest(s.expectedContentVersion)) {
      source = { kind: 'tool-result', conversationId: s.conversationId, toolCallId: s.toolCallId, expectedContentVersion: s.expectedContentVersion };
    } else if (s.kind === 'user-material' && keys(s, ['kind', 'messageId', 'attachmentId', 'expectedContentVersion'])
      && interactiveToken(s.messageId) && interactiveToken(s.attachmentId) && interactiveDigest(s.expectedContentVersion)) {
      source = { kind: 'user-material', messageId: s.messageId, attachmentId: s.attachmentId, expectedContentVersion: s.expectedContentVersion };
    } else if (s.kind === 'model-data' && keys(s, ['kind', 'value']) && jsonValue(s.value)) {
      source = { kind: 'model-data', value: JSON.parse(JSON.stringify(s.value)) as InteractiveJSON };
    } else return;
    const selector = binding.selector === undefined ? undefined : normalizeInteractiveSelector(binding.selector);
    if (binding.selector !== undefined && !selector) return;
    inputs.push({ bindingId: binding.bindingId, source, ...(selector ? { selector } : {}) });
  }
  if (new Set(inputs.map(row => row.bindingId)).size !== inputs.length || bytes(JSON.stringify(inputs)) > INTERACTIVE_RESULT_LIMITS.inputBytes) return;
  return { publication, title: raw.title.trim(), textFallback: raw.textFallback, program: raw.program, inputs };
}
export function normalizeInteractiveInspect(raw: unknown): InteractiveInspectRequest | undefined {
  if (!object(raw) || !keys(raw, ['target', 'view', 'bindingId', 'selector', 'followupId', 'offset', 'limit']) || !object(raw.target)
    || !keys(raw.target, ['kind', 'reference']) || !['metadata', 'text', 'program', 'data', 'evaluate'].includes(raw.view as string)) return;
  let target: InteractiveInspectRequest['target'];
  if (raw.target.kind === 'result') { const reference = normalizeInteractiveReference(raw.target.reference); if (!reference) return; target = { kind: 'result', reference }; }
  else if (raw.target.kind === 'publication') { const reference = normalizeInteractivePublicationReference(raw.target.reference); if (!reference || raw.view !== 'metadata') return; target = { kind: 'publication', reference }; }
  else return;
  if (raw.bindingId !== undefined && (!safeKey(raw.bindingId) || raw.view !== 'data') || raw.view === 'data' && !safeKey(raw.bindingId)
    || raw.followupId !== undefined && (!interactiveToken(raw.followupId) || raw.view !== 'evaluate')
    || raw.offset !== undefined && !integer(raw.offset, 0, INTERACTIVE_RESULT_LIMITS.programBytes)
    || raw.limit !== undefined && !integer(raw.limit, 1, 4000)) return;
  const selector = raw.selector === undefined ? undefined : normalizeInteractiveSelector(raw.selector);
  if (raw.selector !== undefined && (!selector || raw.view !== 'data')) return;
  return { target, view: raw.view as InteractiveInspectRequest['view'], ...(raw.bindingId ? { bindingId: raw.bindingId as string } : {}),
    ...(selector ? { selector } : {}), ...(raw.followupId ? { followupId: raw.followupId as string } : {}),
    ...(raw.offset !== undefined ? { offset: raw.offset as number } : {}), ...(raw.limit !== undefined ? { limit: raw.limit as number } : {}) };
}

/** An opaque, version-pinned locator. Hosts must revalidate the canonical publication receipt. */
export function interactiveArtifactRef(ref: InteractiveResultReference): string {
  const value = normalizeInteractiveReference(ref); if (!value) throw new TypeError('invalid_interactive_reference');
  return `interactive-result://${value.owner.workspaceId}/${value.owner.conversationId}/${value.resultId}/${value.contentVersion.slice(7)}`;
}
export function parseInteractiveArtifactRef(raw: unknown): InteractiveResultReference | undefined {
  if (typeof raw !== 'string' || raw.length > 1024) return;
  const match = /^interactive-result:\/\/([^/]+)\/([^/]+)\/([^/]+)\/([a-f0-9]{64})$/.exec(raw);
  return match ? normalizeInteractiveReference({ owner: { workspaceId: match[1], conversationId: match[2] }, resultId: match[3], contentVersion: `sha256:${match[4]}` }) : undefined;
}
export function normalizeInteractiveUserArtifact(raw: unknown): InteractiveUserArtifact | undefined {
  if (!object(raw) || !keys(raw, ['kind', 'ref', 'label', 'reference', 'specHash']) || raw.kind !== 'interactive'
    || !text(raw.label, 640) || raw.label.length > 160 || !interactiveDigest(raw.specHash)) return;
  const reference = normalizeInteractiveReference(raw.reference);
  if (!reference || raw.ref !== interactiveArtifactRef(reference)) return;
  return { kind: 'interactive', ref: raw.ref, label: raw.label, reference, specHash: raw.specHash };
}
