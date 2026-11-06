import {
  normalizeResourceEditTarget, normalizeResourceTextDraft, normalizeResourceEditWriter, normalizeResourceEditReceipt, normalizeResourceEditOperation,
  resourceEditToken, resourceEditDigest, validResourceEditText, RESOURCE_TEXT_DRAFT_LIMIT, RESOURCE_EDIT_OPERATION_LIMIT,
  type ResourceEditTarget, type ResourceTextDraft, type ResourceEditWriter, type ResourceEditOperation, type ResourceEditReceipt,
} from '@peer-agent/protocol';

/** No filesystem, permission, runner, tool or Evidence creation ports. Host facts enter explicitly. */
export interface ResourceEditState {
  readonly schemaVersion: 1; readonly workspaceId: string; readonly hostEpoch: string; readonly revision: number;
  readonly drafts: readonly ResourceTextDraft[]; readonly operations: readonly ResourceEditOperation[];
  readonly retiredOperations: readonly ResourceEditOperation[];
  readonly writerSequence: number; readonly writers: readonly { readonly draftId: string; readonly writer: ResourceEditWriter }[];
}
export interface ResourceEditPorts { readonly hashText: (text: string) => string; readonly now: () => string }
export type ResourceEditEvent =
  | { readonly type: 'open'; readonly id: string; readonly target: ResourceEditTarget; readonly baseText: string }
  | { readonly type: 'acquire'; readonly draftId: string; readonly writer: Omit<ResourceEditWriter, 'lease'>; readonly takeover?: boolean }
  | { readonly type: 'release'; readonly draftId: string; readonly writer: ResourceEditWriter }
  | { readonly type: 'edit'; readonly draftId: string; readonly revision: number; readonly writer: ResourceEditWriter; readonly text: string }
  | { readonly type: 'discard'; readonly draftId: string; readonly revision: number; readonly writer: ResourceEditWriter }
  | { readonly type: 'reserve'; readonly requestId: string; readonly draftId: string; readonly revision: number; readonly writer: ResourceEditWriter; readonly providerId: string; readonly proposedVersion: string }
  | { readonly type: 'archive'; readonly requestId: string }
  | { readonly type: 'start'; readonly requestId: string; readonly payloadHash: string }
  | { readonly type: 'withdraw'; readonly requestId: string; readonly payloadHash: string }
  | { readonly type: 'uncertain'; readonly requestId: string; readonly payloadHash: string }
  | { readonly type: 'settle'; readonly requestId: string; readonly receipt: ResourceEditReceipt };
export type ResourceEditTransition = { readonly ok: false; readonly code: string } | {
  readonly ok: true; readonly state: ResourceEditState; readonly persist: boolean;
  /** execute only marks a fresh journal transition; persist it, then use the governed runtime. It is never a grant. */
  readonly value: { readonly draft?: ResourceTextDraft; readonly writer?: ResourceEditWriter; readonly operation?: ResourceEditOperation; readonly execute?: boolean };
};
const fail = (code: string): ResourceEditTransition => ({ ok: false, code });
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const clone = <T>(value: T): T => structuredClone(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function resourceEditOperationPayload(op: Pick<ResourceEditOperation, 'draftId' | 'draftRevision' | 'target' | 'providerId' | 'proposedVersion'>): string {
  return JSON.stringify({ draftId: op.draftId, draftRevision: op.draftRevision, target: op.target, providerId: op.providerId, proposedVersion: op.proposedVersion });
}
export function emptyResourceEditState(workspaceId: string, hostEpoch: string): ResourceEditState {
  if (!resourceEditToken(workspaceId) || !resourceEditToken(hostEpoch)) throw TypeError('INVALID_RESOURCE_EDIT_SCOPE');
  return { schemaVersion: 1, workspaceId, hostEpoch, revision: 0, drafts: [], operations: [], retiredOperations: [], writers: [], writerSequence: 0 };
}
/** Hydrated durable intent. Writer handles are deliberately absent from the persisted shape. */
export function resourceEditManifest(state: ResourceEditState) {
  return clone({ schemaVersion: state.schemaVersion, workspaceId: state.workspaceId, revision: state.revision, drafts: state.drafts, operations: state.operations, retiredOperations: state.retiredOperations });
}
export function recoverResourceEditState(raw: unknown, workspaceId: string, hostEpoch: string, hashText: ResourceEditPorts['hashText']): ResourceEditState | undefined {
  if (!resourceEditToken(workspaceId) || !resourceEditToken(hostEpoch) || !object(raw) || Object.keys(raw).some(key => !['schemaVersion', 'workspaceId', 'revision', 'drafts', 'operations', 'retiredOperations'].includes(key))
    || raw.schemaVersion !== 1 || raw.workspaceId !== workspaceId || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0
    || !Array.isArray(raw.drafts) || raw.drafts.length > RESOURCE_TEXT_DRAFT_LIMIT || !Array.isArray(raw.operations) || raw.operations.length > RESOURCE_EDIT_OPERATION_LIMIT
    || raw.retiredOperations !== undefined && (!Array.isArray(raw.retiredOperations) || raw.retiredOperations.length > 1024)) return;
  const drafts = raw.drafts.map(normalizeResourceTextDraft), operations = raw.operations.map(normalizeResourceEditOperation);
  const retired = (raw.retiredOperations as unknown[] | undefined ?? []).map(normalizeResourceEditOperation);
  const all = [...operations, ...retired];
  if (drafts.some(d => !d || d.target.recipient.workspaceId !== workspaceId || hashText(d.baseText) !== d.target.base.contentVersion)
    || retired.some(op => !op || op.phase !== 'settled')
    || all.some(op => !op || op.target.recipient.workspaceId !== workspaceId || hashText(resourceEditOperationPayload(op)) !== op.payloadHash)
    || new Set(drafts.map(d => d?.id)).size !== drafts.length || new Set(drafts.map(d => JSON.stringify(d?.target))).size !== drafts.length
    || new Set(all.map(op => op?.requestId)).size !== all.length) return;
  for (const op of all as ResourceEditOperation[]) {
    const draft = drafts.find(d => d!.id === op.draftId);
    if (draft && (!equal(draft.target, op.target) || draft.revision < op.draftRevision)
      || all.some(other => other!.draftId === op.draftId && !equal(other!.target, op.target))) return;
  }
  // A retained running journal is uncertainty, never an invitation to execute again.
  return { ...emptyResourceEditState(workspaceId, hostEpoch), revision: Number(raw.revision), drafts: drafts as ResourceTextDraft[],
    retiredOperations: retired as ResourceEditOperation[],
    operations: operations.map(op => op!.phase === 'running' && op!.hostEpoch !== hostEpoch ? { ...op!, phase: 'uncertain' as const } : op!) };
}
export function reduceResourceEdit(state: ResourceEditState, event: ResourceEditEvent, ports: ResourceEditPorts): ResourceEditTransition {
  const at = ports.now(); if (!Number.isFinite(Date.parse(at))) return fail('INVALID_RESOURCE_EDIT_TIME');
  const timestamp = new Date(at).toISOString();
  const finish = (next: ResourceEditState, value: Extract<ResourceEditTransition, { ok: true }>['value'], persist = true): ResourceEditTransition => {
    if (persist && !Number.isSafeInteger(state.revision + 1)) return fail('RESOURCE_EDIT_REVISION_LIMIT');
    return { ok: true, state: clone({ ...next, revision: persist ? state.revision + 1 : state.revision }), persist, value: clone(value) };
  };
  if (event.type === 'open') {
    const target = normalizeResourceEditTarget(event.target);
    if (!resourceEditToken(event.id) || !target || target.recipient.workspaceId !== state.workspaceId || !validResourceEditText(event.baseText)
      || ports.hashText(event.baseText) !== target.base.contentVersion) return fail('INVALID_RESOURCE_EDIT_DRAFT');
    const same = state.drafts.find(d => equal(d.target, target)), withId = state.drafts.find(d => d.id === event.id);
    if (withId && !equal(withId.target, target)) return fail('RESOURCE_EDIT_ID_CONFLICT');
    if (!withId && [...state.operations, ...state.retiredOperations].some(op => op.draftId === event.id)) return fail('RESOURCE_EDIT_ID_CONFLICT');
    if (same) return finish(state, { draft: same }, false);
    if (state.drafts.length >= RESOURCE_TEXT_DRAFT_LIMIT) return fail('RESOURCE_EDIT_DRAFT_LIMIT');
    const draft: ResourceTextDraft = { id: event.id, target, baseText: event.baseText, text: event.baseText, revision: 0, createdAt: timestamp, updatedAt: timestamp };
    return finish({ ...state, drafts: [...state.drafts, draft] }, { draft });
  }
  if (event.type === 'archive') {
    const op = state.operations.find(row => row.requestId === event.requestId);
    if (!op) return state.retiredOperations.some(row => row.requestId === event.requestId) ? finish(state, {}, false) : fail('RESOURCE_EDIT_OPERATION_MISSING');
    if (op.phase !== 'settled') return fail('RESOURCE_EDIT_OPERATION_PENDING');
    if (state.retiredOperations.length >= 1024) return fail('RESOURCE_EDIT_HISTORY_LIMIT');
    return finish({ ...state, operations: state.operations.filter(row => row !== op), retiredOperations: [...state.retiredOperations, op] }, { operation: op });
  }
  if (event.type === 'start' || event.type === 'settle' || event.type === 'uncertain' || event.type === 'withdraw') {
    const op = [...state.operations, ...state.retiredOperations].find(op => op.requestId === event.requestId); if (!op) return fail('RESOURCE_EDIT_OPERATION_MISSING');
    if (event.type === 'withdraw') {
      if (event.payloadHash !== op.payloadHash) return fail('RESOURCE_EDIT_ID_CONFLICT');
      if (op.phase === 'settled') return finish(state, { operation: op }, false);
      if (op.phase !== 'prepared') return fail('RESOURCE_EDIT_OPERATION_PENDING');
      const operation: ResourceEditOperation = { ...op, phase: 'settled', receipt: { outcome: 'cancelled' }, updatedAt: timestamp };
      return finish({ ...state, operations: state.operations.map(row => row === op ? operation : row) }, { operation });
    }
    if (event.type === 'uncertain') {
      if (event.payloadHash !== op.payloadHash) return fail('RESOURCE_EDIT_ID_CONFLICT');
      if (op.phase === 'prepared') return fail('RESOURCE_EDIT_NOT_STARTED');
      if (op.phase === 'settled' || op.phase === 'uncertain') return finish(state, { operation: op }, false);
      const operation: ResourceEditOperation = { ...op, phase: 'uncertain', updatedAt: timestamp };
      return finish({ ...state, operations: state.operations.map(row => row === op ? operation : row) }, { operation });
    }
    if (event.type === 'start') {
      if (event.payloadHash !== op.payloadHash) return fail('RESOURCE_EDIT_ID_CONFLICT');
      if (op.phase === 'uncertain' || op.phase === 'running' && op.hostEpoch !== state.hostEpoch) return fail('RESOURCE_EDIT_RESULT_UNCERTAIN');
      if (op.phase !== 'prepared') return finish(state, { operation: op, execute: false }, false);
      const operation: ResourceEditOperation = { ...op, phase: 'running', hostEpoch: state.hostEpoch, updatedAt: timestamp };
      return finish({ ...state, operations: state.operations.map(row => row === op ? operation : row) }, { operation, execute: true });
    }
    const receipt = normalizeResourceEditReceipt(event.receipt);
    if (!receipt || receipt.outcome === 'applied' && receipt.observedVersion !== op.proposedVersion) return fail('INVALID_RESOURCE_EDIT_RECEIPT');
    if (op.phase === 'settled') return equal(op.receipt, receipt) ? finish(state, { operation: op }, false) : fail('RESOURCE_EDIT_RECEIPT_CONFLICT');
    if (op.phase === 'prepared') return fail('RESOURCE_EDIT_NOT_STARTED');
    const operation: ResourceEditOperation = { ...op, phase: 'settled', receipt, updatedAt: timestamp };
    // A previous revision's success cannot clear or rebase text entered later.
    return finish({ ...state, operations: state.operations.map(row => row === op ? operation : row) }, { operation });
  }
  const draft = state.drafts.find(d => d.id === event.draftId); if (!draft) return fail('RESOURCE_EDIT_DRAFT_MISSING');
  const binding = state.writers.find(item => item.draftId === draft.id);
  if (event.type === 'acquire') {
    if (event.takeover !== undefined && typeof event.takeover !== 'boolean' || !Number.isSafeInteger(state.writerSequence + 1)) return fail('INVALID_RESOURCE_EDIT_WRITER');
    const writer = normalizeResourceEditWriter({ ...event.writer, lease: state.writerSequence + 1 }); if (!writer) return fail('INVALID_RESOURCE_EDIT_WRITER');
    if (binding && equal({ ...binding.writer, lease: 0 }, { ...writer, lease: 0 })) return finish(state, { writer: binding.writer, draft }, false);
    if (binding && !event.takeover) return fail('RESOURCE_EDIT_WRITER_BUSY');
    return finish({ ...state, writerSequence: writer.lease, writers: [...state.writers.filter(item => item.draftId !== draft.id), { draftId: draft.id, writer }] }, { writer, draft }, false);
  }
  if (!binding || !equal(binding.writer, normalizeResourceEditWriter(event.writer))) return fail('RESOURCE_EDIT_STALE_WRITER');
  if (event.type === 'release') return finish({ ...state, writers: state.writers.filter(item => item !== binding) }, {}, false);
  if (event.type === 'reserve') {
    if (!resourceEditToken(event.requestId) || !resourceEditToken(event.providerId) || !resourceEditDigest(event.proposedVersion)) return fail('INVALID_RESOURCE_EDIT_OPERATION');
    const prior = [...state.operations, ...state.retiredOperations].find(op => op.requestId === event.requestId);
    if (prior) return prior.draftId === draft.id && prior.draftRevision === event.revision && prior.providerId === event.providerId && prior.proposedVersion === event.proposedVersion && equal(prior.target, draft.target)
      ? finish(state, { operation: prior, execute: false }, false) : fail('RESOURCE_EDIT_ID_CONFLICT');
    if (state.operations.some(op => op.phase !== 'settled' && (op.target.base.resourceId === draft.target.base.resourceId || op.target.reference.path === draft.target.reference.path)
      && (op.phase !== 'uncertain' || op.draftId === draft.id || op.target.base.contentVersion === draft.target.base.contentVersion))) return fail('RESOURCE_EDIT_OPERATION_PENDING');
    if (draft.revision !== event.revision) return fail('RESOURCE_EDIT_DRAFT_CONFLICT');
    if (ports.hashText(draft.text) !== event.proposedVersion) return fail('RESOURCE_EDIT_PAYLOAD_CHANGED');
    if (state.operations.length >= RESOURCE_EDIT_OPERATION_LIMIT) return fail('RESOURCE_EDIT_OPERATION_LIMIT');
    const payload = { draftId: draft.id, draftRevision: draft.revision, target: draft.target, providerId: event.providerId, proposedVersion: event.proposedVersion };
    const operation: ResourceEditOperation = { ...payload, requestId: event.requestId, payloadHash: ports.hashText(resourceEditOperationPayload(payload)), phase: 'prepared', createdAt: timestamp, updatedAt: timestamp };
    return finish({ ...state, operations: [...state.operations, operation] }, { operation, execute: false });
  }
  if (draft.revision !== event.revision) return fail('RESOURCE_EDIT_DRAFT_CONFLICT');
  if (event.type === 'discard') {
    if (state.operations.some(op => op.draftId === draft.id && op.phase !== 'settled')) return fail('RESOURCE_EDIT_OPERATION_PENDING');
    return finish({ ...state, drafts: state.drafts.filter(row => row !== draft), writers: state.writers.filter(item => item !== binding) }, {});
  }
  if (!validResourceEditText(event.text) || !Number.isSafeInteger(draft.revision + 1)) return fail('INVALID_RESOURCE_EDIT_TEXT');
  if (event.text === draft.text) return finish(state, { draft }, false);
  const changed: ResourceTextDraft = { ...draft, text: event.text, revision: draft.revision + 1, updatedAt: timestamp };
  return finish({ ...state, drafts: state.drafts.map(row => row === draft ? changed : row) }, { draft: changed });
}
