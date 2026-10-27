import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { normalizeResourceEditTarget, RESOURCE_FILE_REPLACE_PROVIDER,
  type ResourceEditsApi, type ResourceEditOperation, type ResourceEditOperationStatus, type ResourceEditResult, type ResourceEditView, type ResourceEditWriter } from '@peer-agent/protocol';
import { createResourceEditSession } from './resourceEditSession.ts';
import { createResourceSubmissionController } from './resourceSubmissionController.ts';
const hash = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const time = '2026-10-27T01:00:00.000Z';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }
type MutableApi = { -readonly [K in keyof ResourceEditsApi]: ResourceEditsApi[K] };
async function fixture(t: TestContext) {
  const target = normalizeResourceEditTarget({ recipient: { workspaceId: 'bot', conversationId: 'conversation' }, reference: { workspaceId: 'bot', path: '/fixture/a.md' }, base: { resourceId: hash('resource'), contentVersion: hash('base') } })!;
  let view: ResourceEditView = { handle: { viewId: 'view-1', windowId: 'window', generation: 1, draftId: 'draft' }, draft: { id: 'draft', target, baseText: 'base', text: 'chosen', revision: 1, createdAt: time, updatedAt: time } }, ids = 0, timer = 0;
  const rows = new Map<string, ResourceEditOperation>(), bodies = new Map<string, string>(), closed = new Set<string>(), timers = new Map<number, () => void>();
  const calls = { submit: [] as Parameters<ResourceEditsApi['submit']>[0][], continue: 0, cancel: 0, decide: 0, reconcile: 0, details: 0, saves: [] as string[] };
  const writer = (): ResourceEditWriter => ({ viewId: view.handle.viewId, windowId: view.handle.windowId, generation: view.handle.generation, token: `writer-${view.handle.generation}`, lease: view.handle.generation });
  const status = (id: string): ResourceEditResult<ResourceEditOperationStatus> => { const op = rows.get(id); return op ? { ok: true, operation: structuredClone(op), live: op.phase === 'running', hostOwnedHere: true,
    hasActualResult: false, governance: 'unavailable', permission: null } : { ok: false, code: 'RESOURCE_EDIT_OPERATION_MISSING' }; };
  const put = (id: string, phase: ResourceEditOperation['phase'] = 'running') => {
    const operation: ResourceEditOperation = { requestId: id, draftId: 'draft', draftRevision: view.draft.revision, target, providerId: RESOURCE_FILE_REPLACE_PROVIDER,
      proposedVersion: hash(view.draft.text), payloadHash: hash(`fixture-payload:${id}`), phase, ...(phase !== 'prepared' ? { hostEpoch: 'fixture-host' } : {}), createdAt: time, updatedAt: time,
      ...(phase === 'settled' ? { receipt: { outcome: 'failed' as const } } : {}) };
    rows.set(id, operation); bodies.set(id, view.draft.text); return operation;
  };
  const api = {
    acquire: async () => ({ ok: true, ...structuredClone(view), writer: writer() }), read: async () => ({ ok: true, ...structuredClone(view) }),
    resume: async () => { view = { ...view, handle: { ...view.handle, generation: view.handle.generation + 1, viewId: `view-${view.handle.generation + 1}` } }; return { ok: true, ...structuredClone(view) }; },
    close: async handle => { closed.add(JSON.stringify(handle)); return { ok: true }; },
    save: async request => { calls.saves.push(request.text); view = { ...view, draft: { ...view.draft, text: request.text, revision: view.draft.revision + 1 } }; return { ok: true, saved: { draftId: 'draft', revision: view.draft.revision, updatedAt: time, textVersion: hash(request.text) } }; },
    list: async () => ({ ok: true, drafts: [], operations: [...rows.values()].map(op => structuredClone(op)), nextCursor: null, staleCount: 0 }),
    operationStatus: async request => status(request.requestId),
    submit: async request => { calls.submit.push(request); if (closed.has(JSON.stringify(request.handle))) return { ok: false, code: 'RESOURCE_EDIT_VIEW_EXPIRED' };
      if (!rows.has(request.requestId)) put(request.requestId); return status(request.requestId); },
    continueSubmission: async request => { calls.continue++; rows.set(request.requestId, { ...rows.get(request.requestId)!, phase: 'running', hostEpoch: 'fixture-host' }); return status(request.requestId); },
    cancelSubmission: async request => { calls.cancel++; rows.set(request.requestId, { ...rows.get(request.requestId)!, phase: 'settled', receipt: { outcome: 'cancelled' } }); return status(request.requestId); },
    decideSubmissionPermission: async () => { calls.decide++; return { ok: true }; },
    reconcileSubmission: async request => { calls.reconcile++; const found = status(request.requestId); return found.ok ? { ...found, observation: 'matches_proposed' as const } : found; },
    readSubmission: async request => { calls.details++; const operation = rows.get(request.requestId); return operation ? { ok: true, operation, baseText: 'base', text: bodies.get(request.requestId)! } : { ok: false, code: 'RESOURCE_EDIT_OPERATION_MISSING' }; },
    readExecution: async () => ({ ok: false, code: 'RESOURCE_EDIT_EXECUTION_MISSING' }),
  } satisfies Partial<ResourceEditsApi>;
  const typed = api as unknown as MutableApi;
  const session = createResourceEditSession({ api: typed, workspaceId: 'bot', draftId: 'draft', initial: structuredClone(view), hashText: async text => hash(text),
    schedule: callback => { const id = ++timer; timers.set(id, callback); return id as unknown as ReturnType<typeof setTimeout>; }, cancel: id => { timers.delete(id as unknown as number); } });
  const controller = createResourceSubmissionController({ session, api: typed, createId: () => `submission-${++ids}`, hashText: async text => hash(text) });
  t.after(async () => { controller.activate(false); await session.close(); });
  await session.claim(); controller.activate(true); await controller.refresh();
  return { api: typed, session, controller, calls, rows, bodies, put, status, closed };
}
test('activation, notices, history selection and reconciliation only read; recovered prepared/uncertain operations never start themselves', async t => {
  const f = await fixture(t); f.put('prepared', 'prepared'); await f.controller.refresh();
  assert.equal(f.controller.snapshot().status?.operation.phase, 'prepared'); assert.equal(f.calls.submit.length, 0); assert.equal(f.calls.continue, 0);
  f.controller.receive({ kind: 'operation', workspaceId: 'bot', draftId: 'draft', requestId: 'prepared' }); await f.controller.refresh(); assert.equal(f.calls.continue, 0);
  assert.equal(await f.controller.continueSubmission(), true); assert.equal(f.calls.continue, 1);
  f.rows.set('prepared', { ...f.rows.get('prepared')!, phase: 'uncertain' }); await f.controller.refresh();
  assert.equal(await f.controller.continueSubmission(), false); await f.controller.reconcile(); assert.equal(f.calls.reconcile, 1); assert.equal(f.calls.submit.length, 0);
});
test('awaiting a refresh includes a notice received behind its captured operation index', async t => {
  const f = await fixture(t), list = f.api.list, entered = deferred<void>(), release = deferred<void>(); let first = true;
  f.api.list = async request => { const captured = await list(request); if (first) { first = false; entered.resolve(); await release.promise; } return captured; };
  const refreshing = f.controller.refresh();
  try {
    await entered.promise; f.put('late-index', 'prepared');
    f.controller.receive({ kind: 'operation', workspaceId: 'bot', draftId: 'draft', requestId: 'late-index' });
    const latest = f.controller.refresh(); release.resolve(); assert.equal(await refreshing, true); assert.equal(await latest, true);
    assert.equal(f.controller.snapshot().status?.operation.requestId, 'late-index'); assert.equal(f.calls.submit.length, 0);
  } finally { release.resolve(); await refreshing; }
});
test('one submission is pinned once; later input saves separately and a lost IPC acknowledgement cannot block a real received state or revive running after settlement', async t => {
  const f = await fixture(t), original = f.api.submit, entered = deferred<void>(), release = deferred<Awaited<ReturnType<ResourceEditsApi['submit']>>>();
  f.api.submit = async request => { await original(request); entered.resolve(); return release.promise; };
  const first = f.controller.submit(), double = f.controller.submit(); assert.equal(first, double);
  try {
    await entered.promise; const id = f.calls.submit[0]!.requestId, earlier = f.status(id);
    f.session.edit('later input'); await f.session.flush(); await f.controller.refresh();
    assert.equal(f.controller.snapshot().intent, null); assert.equal(f.controller.snapshot().action, null); assert.equal(f.bodies.get(id), 'chosen'); assert.equal(f.session.snapshot().text, 'later input');
    f.rows.set(id, { ...f.rows.get(id)!, phase: 'settled', receipt: { outcome: 'failed' } }); await f.controller.refresh();
    release.resolve(earlier); await first;
    assert.equal(f.controller.snapshot().status?.operation.phase, 'settled'); assert.equal(f.controller.snapshot().status?.live, false); assert.equal(f.calls.submit.length, 1);
    assert.equal(JSON.stringify(f.calls.submit).includes('chosen'), false); assert.equal(JSON.stringify(f.calls.submit).includes('later input'), false);
  } finally { release.resolve({ ok: false, code: 'RESOURCE_EDIT_SOURCE_UNAVAILABLE' }); await first; }
});
test('IME and an input change during initial save never silently submit newer text', async t => {
  const f = await fixture(t); f.session.setComposing(true); assert.equal(await f.controller.submit(), false); assert.equal(f.calls.submit.length, 0); f.session.setComposing(false);
  f.session.edit('before click'); const save = f.api.save, entered = deferred<void>(), release = deferred<void>(); let once = true;
  f.api.save = async request => { if (once) { once = false; entered.resolve(); await release.promise; } return save(request); };
  const pending = f.controller.submit();
  try { await entered.promise; f.session.edit('typed while saving'); release.resolve(); assert.equal(await pending, false);
    assert.equal(f.calls.submit.length, 0); assert.equal(f.controller.snapshot().error, 'RESOURCE_EDIT_SUBMIT_INPUT_CHANGED'); assert.equal(f.session.snapshot().text, 'typed while saving');
  } finally { release.resolve(); await pending; }
});
test('an unreceived request keeps its identity; only confirmed old-view retirement plus a new scoped absence allows a separate submission', async t => {
  const f = await fixture(t), original = f.api.submit, entered = deferred<void>(), release = deferred<void>();
  f.api.submit = async request => { entered.resolve(); await release.promise; return original(request); };
  const pending = f.controller.submit();
  try {
    await entered.promise; await f.controller.refresh(); const intent = f.controller.snapshot().intent!;
    assert.ok(intent); assert.equal(f.controller.snapshot().missing, true); assert.equal(f.calls.submit.length, 0);
    assert.equal(await f.controller.reconnectMissing(), true); assert.equal(f.closed.has(JSON.stringify(intent.handle)), true); assert.equal(f.controller.snapshot().intent, null);
    f.api.submit = original; await f.session.claim(); assert.equal(await f.controller.submit(), true);
    const next = f.controller.snapshot().selectedId; assert.notEqual(next, intent.requestId);
    release.resolve(); await pending; assert.equal(f.controller.snapshot().selectedId, next); assert.equal(f.rows.has(intent.requestId), false);
  } finally { release.resolve(); await pending; }
});
test('fixed submission text never follows later edits; a wrong view/target response cannot become a new permission or applied state', async t => {
  const f = await fixture(t); await f.controller.submit(); const id = f.controller.snapshot().selectedId!;
  f.session.edit('after submit'); await f.session.flush(); await f.controller.loadDetails(); assert.equal(f.controller.snapshot().preview?.text, 'chosen');
  const original = f.api.operationStatus; f.api.operationStatus = async request => { const result = await original(request); return result.ok ? { ...result, operation: { ...result.operation, target: { ...result.operation.target, reference: { ...result.operation.target.reference, path: '/elsewhere/a.md' } } } } : result; };
  await f.controller.refresh(); assert.equal(f.controller.snapshot().error, 'RESOURCE_EDIT_SOURCE_CHANGED'); assert.equal(f.controller.snapshot().status, null); assert.equal(f.calls.submit.length, 1);
  assert.equal(f.rows.has(id), true); assert.equal(f.session.snapshot().text, 'after submit');
});
