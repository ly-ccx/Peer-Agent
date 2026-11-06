import { normalizeResourceEditOperation, normalizeResourceEditExecutionRecord, normalizeResourceEditPostlude, resourceEditExecutionMatches, resourceEditToken, validResourceEditText,
  type ResourceEditsApi, type ResourceEditOperation, type ResourceEditOperationStatus, type ResourceEditViewHandle, type ResourceEditNotice,
  type ResourceEditExecutionRecord, type ResourceEditPostlude } from '@peer-agent/protocol';
import type { ResourceEditSession } from './resourceEditSession.ts';
import { feedbackDigest } from '../feedback/resourceSelection.ts';
import { sameEditHandle, submissionOperation, submissionStatus, submissionReadiness } from './resourceSubmissionState.ts';
export interface ResourceSubmissionState {
  readonly operations: readonly ResourceEditOperation[]; readonly blockers: number; readonly selectedId: string | null; readonly status: ResourceEditOperationStatus | null;
  readonly ready: boolean; readonly refreshing: boolean; readonly action: 'submit' | 'continue' | 'cancel' | 'permission' | 'reconcile' | 'reconnect' | null; readonly error: string | null;
  readonly intent: { readonly requestId: string; readonly revision: number; readonly handle: ResourceEditViewHandle } | null; readonly missing: boolean;
  readonly preview: { readonly operation: ResourceEditOperation; readonly baseText: string; readonly text: string } | null;
  readonly execution: { readonly record: ResourceEditExecutionRecord; readonly postlude: ResourceEditPostlude | null } | null;
  readonly detailsLoading: boolean; readonly previewError: string | null; readonly executionError: string | null;
}
/** One draft's local presentation/transport continuity. Only explicit methods can submit/continue/decide/cancel. */
export function createResourceSubmissionController({ session, api, createId = () => crypto.randomUUID(), hashText = feedbackDigest }: {
  readonly session: ResourceEditSession; readonly api: ResourceEditsApi; readonly createId?: () => string; readonly hashText?: (text: string) => Promise<string>;
}) {
  let state: ResourceSubmissionState = { operations: [], blockers: 0, selectedId: null, status: null, ready: false, refreshing: false, action: null, error: null,
    intent: null, missing: false, preview: null, execution: null, detailsLoading: false, previewError: null, executionError: null };
  const listeners = new Set<() => void>(), retired = new Set<string>(), transports = new Set<Promise<boolean>>(), activeOwners = new Set<object>(), defaultOwner = {};
  let active = false, epoch = 0, detailsEpoch = 0, executionEpoch = 0, scope: ResourceEditViewHandle | null = null;
  let refreshing: Promise<boolean> | null = null, action: Promise<boolean> | null = null, again = false;
  function publish(patch: Partial<ResourceSubmissionState>) { state = { ...state, ...patch }; for (const listener of listeners) listener(); }
  function current(handle: ResourceEditViewHandle, ticket: number) { return active && epoch === ticket && sameEditHandle(session.snapshot().view?.handle, handle); }
  function updateStatus(value: ResourceEditOperationStatus) {
    const others = state.operations.filter(op => op.requestId !== value.operation.requestId);
    const received = state.intent?.requestId === value.operation.requestId;
    // The durable receipt can arrive before its IPC response. Keep that Promise, but let the real pending decision be actionable.
    const acknowledged = received && state.action === 'submit' || state.action === 'continue' && value.operation.phase !== 'prepared'
      || state.action === 'permission' && !value.permission || state.action === 'cancel' && (value.operation.phase === 'settled' || value.operation.phase === 'uncertain' && !value.live);
    if (acknowledged) action = null;
    const observed = value.observation ?? (state.status?.operation.requestId === value.operation.requestId ? state.status.observation : undefined);
    publish({ selectedId: value.operation.requestId, status: { ...value, ...(observed ? { observation: observed } : {}) }, operations: [value.operation, ...others], missing: false, error: null,
      ...(received ? { intent: null } : {}), ...(acknowledged ? { action: null } : {}) });
  }
  async function fetchExecution(handle: ResourceEditViewHandle, id: string, op: ResourceEditOperation, ticket: number) {
    const execution = ++executionEpoch, valid = () => current(handle, ticket) && state.selectedId === id && executionEpoch === execution;
    try {
      const result = await api.readExecution({ handle, requestId: id }); if (!valid()) return;
      if (!result.ok) { publish({ execution: null, executionError: result.code }); return; }
      const record = normalizeResourceEditExecutionRecord(result.record), postlude = result.postlude ? normalizeResourceEditPostlude(result.postlude) : null;
      if (!record || !resourceEditExecutionMatches(record, op) || result.postlude && (!postlude || postlude.requestId !== id || postlude.payloadHash !== op.payloadHash)) throw Error('invalid execution association');
      publish({ execution: { record, postlude: postlude ?? null }, executionError: null });
    } catch { if (valid()) publish({ execution: null, executionError: 'RESOURCE_EDIT_SOURCE_UNAVAILABLE' }); }
  }
  function response(raw: Awaited<ReturnType<ResourceEditsApi['operationStatus']>>, id: string, handle: ResourceEditViewHandle, ticket: number, command = false) {
    if (!current(handle, ticket) || state.selectedId !== id) return false;
    if (!raw.ok) { publish({ error: raw.code, missing: raw.code === 'RESOURCE_EDIT_OPERATION_MISSING', ...(/VIEW_EXPIRED|SOURCE_CHANGED|RECIPIENT_CHANGED/.test(raw.code) ? { status: null, preview: null, execution: null, ready: false } : {}) }); return false; }
    const value = submissionStatus(raw, session.snapshot(), session.workspaceId, session.draftId, id), previous = state.operations.find(op => op.requestId === id);
    if (!value || previous && previous.payloadHash !== value.operation.payloadHash) { publish({ error: 'RESOURCE_EDIT_SOURCE_CHANGED', status: null, preview: null, execution: null, ready: false }); return false; }
    const order = { prepared: 0, running: 1, uncertain: 2, settled: 3 };
    if (previous && order[previous.phase] > order[value.operation.phase]) return true;
    if (previous?.phase === 'settled' && value.operation.phase === 'settled' && JSON.stringify(previous.receipt) !== JSON.stringify(value.operation.receipt)) { publish({ error: 'RESOURCE_EDIT_RECEIPT_CONFLICT' }); return false; }
    const known = state.status?.operation.requestId === id ? state.status : null, governance = { unavailable: 0, pending: 1, unconfirmed: 2, recorded: 3 };
    updateStatus(known && order[known.operation.phase] >= order[value.operation.phase] ? { ...value,
      live: known.operation.phase !== 'prepared' && !known.live ? false : value.live,
      permission: command && value.permission ? known.permission : value.permission,
      ...(command ? { permissionElsewhere: known.permissionElsewhere ?? false } : {}),
      hasActualResult: known.hasActualResult || value.hasActualResult,
      governance: governance[known.governance] > governance[value.governance] ? known.governance : value.governance } : value); return true;
  }
  async function refreshPass(): Promise<boolean> {
    const handle = session.snapshot().view?.handle; if (!active || !handle) return false;
    const ticket = epoch;
      publish({ refreshing: true });
      try {
        const all: ResourceEditOperation[] = []; let cursor: string | undefined;
        for (let page = 0; page < 18; page++) {
          const result = await api.list({ workspaceId: session.workspaceId, handle, limit: 64, ...(cursor ? { cursor } : {}) });
          if (!current(handle, ticket)) return false;
          if (!result.ok) { publish({ error: result.code, ready: false }); return false; }
          for (const raw of result.operations) { const op = normalizeResourceEditOperation(raw); if (!op || op.target.recipient.workspaceId !== session.workspaceId) throw Error('invalid operation index'); all.push(op); }
          if (!result.nextCursor) { cursor = undefined; break; }
          if (result.nextCursor === cursor) throw Error('repeated index cursor'); cursor = result.nextCursor;
        }
        if (cursor) throw Error('incomplete operation index');
        const rows = all.filter(op => submissionOperation(op, session.snapshot(), session.workspaceId, session.draftId)), merged = new Map(state.operations.map(op => [op.requestId, op]));
        const order = { prepared: 0, running: 1, uncertain: 2, settled: 3 };
        for (const op of rows) {
          const prior = merged.get(op.requestId);
          if (prior && (prior.payloadHash !== op.payloadHash || prior.phase === 'settled' && op.phase === 'settled' && JSON.stringify(prior.receipt) !== JSON.stringify(op.receipt))) throw Error('conflicting original operation');
          if (!prior || order[op.phase] >= order[prior.phase]) merged.set(op.requestId, op);
        }
        const operations = [...merged.values()];
        const blockers = all.filter(op => op.draftId !== session.draftId && op.phase !== 'settled'
          && (op.phase !== 'uncertain' || op.target.base.contentVersion === session.snapshot().baseline?.target.base.contentVersion)).length;
        const selectedId = state.intent?.requestId ?? (state.selectedId && operations.some(op => op.requestId === state.selectedId) ? state.selectedId : operations.find(op => op.phase !== 'settled')?.requestId ?? operations[0]?.requestId ?? null);
        publish({ operations, blockers, selectedId, ready: true, error: null, ...(selectedId ? {} : { status: null, missing: false }) });
        if (!selectedId) return true;
        const accepted = response(await api.operationStatus({ handle, requestId: selectedId }), selectedId, handle, ticket);
        if (accepted && state.status?.hasActualResult) await fetchExecution(handle, selectedId, state.status.operation, ticket);
        return accepted;
      } catch { if (current(handle, ticket)) publish({ error: 'RESOURCE_EDIT_STATUS_UNAVAILABLE', ready: false }); return false; }
      finally {
        if (current(handle, ticket)) publish({ refreshing: false });
      }
  }
  function refresh(): Promise<boolean> {
    if (refreshing) { again = true; return refreshing; }
    // A caller awaiting refresh also waits for notices received during the in-flight read.
    refreshing = Promise.resolve().then(async () => {
      let accepted = false;
      do { again = false; accepted = await refreshPass(); } while (again && active);
      return accepted;
    }).finally(() => { refreshing = null; });
    return refreshing;
  }
  function run(kind: NonNullable<ResourceSubmissionState['action']>, work: () => Promise<boolean>) {
    if (kind === 'reconnect' && state.action === 'submit' && state.missing && state.intent) action = null;
    if (kind === 'cancel' && state.action === 'permission' && state.status?.live && state.status.operation.phase === 'running') action = null;
    if (action) return action;
    const promise: Promise<boolean> = Promise.resolve().then(work).catch(() => { if (active && action === promise) publish({ error: state.intent ? 'RESOURCE_EDIT_SUBMIT_UNCONFIRMED' : 'RESOURCE_EDIT_STATUS_UNAVAILABLE' }); return false; })
      .finally(() => { transports.delete(promise); if (action === promise) { action = null; publish({ action: null }); } });
    action = promise; transports.add(promise); publish({ action: kind, error: null }); return promise;
  }
  function forSelected(kind: 'continue' | 'cancel' | 'reconcile', call: ResourceEditsApi['operationStatus']) {
    return run(kind, async () => {
      const handle = session.snapshot().view?.handle, id = state.selectedId, ticket = epoch; if (!active || !handle || !id || kind === 'continue' && session.snapshot().composing) return false;
      const result = await call({ handle, requestId: id }); const accepted = response(result, id, handle, ticket, true); if (current(handle, ticket)) void refresh(); return accepted;
    });
  }
  return {
    snapshot: () => state, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    activate(value: boolean, owner: object = defaultOwner) {
      if (value) activeOwners.add(owner); else activeOwners.delete(owner); const nextActive = activeOwners.size > 0;
      const handle = session.snapshot().view?.handle ?? null;
      if (active !== nextActive || !sameEditHandle(scope, handle)) { epoch++; detailsEpoch++; executionEpoch++; scope = handle;
        publish({ ready: false, refreshing: false, status: null, preview: null, execution: null, detailsLoading: false, previewError: null, executionError: null }); }
      active = nextActive; if (nextActive && handle) void refresh();
    },
    refresh,
    receive(notice: ResourceEditNotice) {
      if (notice.workspaceId !== session.workspaceId || notice.draftId && notice.draftId !== session.draftId) return;
      if (notice.kind === 'history') { detailsEpoch++; publish({ preview: null, previewError: 'RESOURCE_EDIT_HISTORY_CHANGED', detailsLoading: false }); }
      if (['operation', 'history'].includes(notice.kind) && active) void refresh();
    },
    readiness: () => transports.size >= 32 ? 'RESOURCE_EDIT_TRANSPORT_LIMIT' : submissionReadiness(session.snapshot(), state.operations, state.ready, !!state.intent, state.blockers, state.status?.observation),
    submit() { return run('submit', async () => {
      if (!active || !state.ready) return false;
      if (transports.size > 32) { publish({ error: 'RESOURCE_EDIT_TRANSPORT_LIMIT' }); return false; }
      const blocked = submissionReadiness(session.snapshot(), state.operations, state.ready, !!state.intent, state.blockers, state.status?.observation);
      if (blocked) { publish({ error: blocked }); return false; }
      const original = session.snapshot().view!.handle, chosenText = session.snapshot().text;
      if (!await session.flush() || !sameEditHandle(original, session.snapshot().view?.handle) || !active) return false;
      const saved = session.snapshot(), handle = saved.view!.handle, writer = saved.writer, ticket = epoch;
      if (saved.text !== chosenText) { publish({ error: 'RESOURCE_EDIT_SUBMIT_INPUT_CHANGED' }); return false; }
      if (!writer || saved.dirty || saved.composing || saved.reviewRequired || saved.remoteChanged) return false;
      const requestId = createId(); if (!resourceEditToken(requestId) || retired.has(requestId) || state.operations.some(op => op.requestId === requestId)) { publish({ error: 'RESOURCE_EDIT_ID_CONFLICT' }); return false; }
      publish({ intent: { requestId, revision: saved.view!.draft.revision, handle }, selectedId: requestId, status: null, preview: null, execution: null, missing: false });
      try { return response(await api.submit({ handle, writer, revision: saved.view!.draft.revision, requestId }), requestId, handle, ticket, true); }
      catch { if (current(handle, ticket) && state.selectedId === requestId && state.intent?.requestId === requestId) publish({ error: 'RESOURCE_EDIT_SUBMIT_UNCONFIRMED' }); return false; }
      finally { if (active) void refresh(); }
    }); },
    continueSubmission: () => state.status?.operation.phase === 'prepared' ? forSelected('continue', api.continueSubmission) : Promise.resolve(false),
    cancel: () => state.status && (state.status.operation.phase === 'prepared' || state.status.live && state.status.operation.phase !== 'settled') ? forSelected('cancel', api.cancelSubmission) : Promise.resolve(false),
    reconcile: () => forSelected('reconcile', api.reconcileSubmission),
    decide(allow: boolean) { return run('permission', async () => {
      const handle = session.snapshot().view?.handle, value = state.status?.permission, ticket = epoch; if (!active || !handle || !value || session.snapshot().composing) return false;
      const result = await api.decideSubmissionPermission({ handle, requestId: value.requestId, challengeId: value.challengeId, argsDigest: value.argsDigest, allow });
      if (!current(handle, ticket)) return false;
      if (!result.ok && state.status?.operation.phase === 'running' && state.status.permission?.challengeId === value.challengeId) publish({ error: result.code });
      await refresh(); return result.ok;
    }); },
    select(id: string) { if (!state.operations.some(op => op.requestId === id) || state.intent || state.action) return; detailsEpoch++; executionEpoch++; publish({ selectedId: id, status: null, preview: null, execution: null, previewError: null, executionError: null }); if (active) void refresh(); },
    async loadDetails() {
      const handle = session.snapshot().view?.handle, id = state.selectedId, op = state.operations.find(op => op.requestId === id), ticket = epoch, detail = ++detailsEpoch;
      if (!active || !handle || !id || !op) return; publish({ detailsLoading: true, previewError: null, executionError: null });
      const valid = () => current(handle, ticket) && detailsEpoch === detail && state.selectedId === id;
      const preview = async () => { try {
        const result = await api.readSubmission({ handle, requestId: id }); if (!valid()) return;
        if (!result.ok) { publish({ preview: null, previewError: result.code }); return; }
        const operation = submissionOperation(result.operation, session.snapshot(), session.workspaceId, session.draftId);
        if (!operation || operation.requestId !== id || operation.payloadHash !== op.payloadHash || !validResourceEditText(result.baseText) || !validResourceEditText(result.text)
          || await hashText(result.baseText) !== op.target.base.contentVersion || await hashText(result.text) !== op.proposedVersion) throw Error('invalid submission text');
        if (valid()) publish({ preview: { operation, baseText: result.baseText, text: result.text } });
      } catch { if (valid()) publish({ preview: null, previewError: 'RESOURCE_EDIT_SOURCE_UNAVAILABLE' }); } };
      await Promise.all([preview(), state.status?.hasActualResult ? fetchExecution(handle, id, op, ticket) : Promise.resolve()]); if (valid()) publish({ detailsLoading: false });
    },
    reconnectMissing() { return run('reconnect', async () => {
      const intent = state.intent; if (!active || !intent || !state.missing || !await session.flush()) return false;
      if (sameEditHandle(session.snapshot().view?.handle, intent.handle)) { if (!await session.close()) return false; }
      else { const closed = await api.close(intent.handle); if (!closed.ok && closed.code !== 'RESOURCE_EDIT_VIEW_EXPIRED') { publish({ error: closed.code }); return false; } }
      if (!await session.connect() || !active) return false;
      const handle = session.snapshot().view!.handle, ticket = ++epoch; scope = handle; await refresh();
      if (!current(handle, ticket)) return false;
      if (state.intent?.requestId !== intent.requestId || !state.missing) return true;
      const checked = await api.operationStatus({ handle, requestId: intent.requestId });
      if (!current(handle, ticket)) return false;
      if (checked.ok) { response(checked, intent.requestId, handle, ticket); return true; }
      if (checked.code !== 'RESOURCE_EDIT_OPERATION_MISSING') { publish({ error: checked.code }); return false; }
      retired.add(intent.requestId); if (retired.size > 128) retired.delete(retired.values().next().value!);
      publish({ intent: null, selectedId: null, status: null, missing: false, error: 'RESOURCE_EDIT_SUBMISSION_NOT_ACCEPTED' }); return true;
    }); },
  };
}
export type ResourceSubmissionController = ReturnType<typeof createResourceSubmissionController>;
