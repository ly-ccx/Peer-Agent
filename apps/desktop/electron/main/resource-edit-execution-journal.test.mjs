import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { RESOURCE_FILE_REPLACE_PROVIDER as providerId } from '@peer-agent/protocol';
import { createResourceEditStorage } from '../../../../packages/runtime-node/src/project-agent/resource-edit-storage.mjs';
import { createResourceEditRuntime } from './resource-edit-runtime.mjs';
import { createResourceEditExecutionJournal } from './resource-edit-execution-journal.mjs';
const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
function deferred() { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; }
function fixture(t, { holdPost, rawFailure = false } = {}) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'peer-execution-journal-'))), file = path.join(root, 'a.md'); writeFileSync(file, 'base');
  const storage = createResourceEditStorage({ rootDir: path.join(root, 'data') }), recorded = deferred(); let current = true, starts = 0, journal;
  t.after(() => { holdPost?.resolve(); journal?.dispose(); storage.close(); rmSync(root, { recursive: true, force: true }); });
  const target = { recipient: { workspaceId: 'bot', conversationId: 'main' }, reference: { workspaceId: 'bot', path: file }, base: { resourceId: hash('id'), contentVersion: hash('base') } };
  storage.apply('bot', { type: 'open', id: 'draft', target, baseText: 'base' });
  const writer = storage.apply('bot', { type: 'acquire', draftId: 'draft', writer: { viewId: 'view', windowId: 'window', generation: 1, token: 'token' } }).writer;
  storage.apply('bot', { type: 'edit', draftId: 'draft', revision: 0, writer, text: 'proposed' });
  const op = storage.apply('bot', { type: 'reserve', requestId: 'request', draftId: 'draft', revision: 1, writer, providerId, proposedVersion: hash('proposed') }).operation;
  const binding = { id: 'real-host-view' }; journal = createResourceEditExecutionJournal({ storage, authorizeStart: candidate => candidate === binding && current,
    isScopeCurrent: candidate => candidate === binding && current,
    readCurrent: async operation => ({ ok: true, resourceId: operation.target.base.resourceId, contentVersion: hash(readFileSync(file)) }),
    createRuntime: (_operation, _binding, ports) => { starts++; return createResourceEditRuntime({ sessionStore: { getSession: () => ({ locale: 'en-US' }) },
      resolveTarget: async () => ({ ok: true, root, path: file, resourceId: target.base.resourceId, validate: () => current }), isIntentCurrent: ports.isIntentCurrent,
      requestPermission: async (_op, call) => ({ granted: true, grant: { grantId: 'actual', toolCallId: call.toolCallId, granted: true, duration: 'once', scope: call.capabilityId, decidedAt: '2026-10-27T03:00:00Z' }, validate: () => current }),
      hookRunner: { runPreToolUse: async () => [], runPostToolUse: async () => { if (holdPost) await holdPost.promise; return []; } },
      recordExecution: (op, record) => {
        if (rawFailure === true) return { ok: false, code: 'RESOURCE_EDIT_STORAGE_UNAVAILABLE' };
        const result = ports.recordExecution(op, record); if (result.ok) recorded.resolve();
        if (rawFailure === 'ack') throw Error('persistence acknowledgement lost after commit');
        return result;
      }, recordPostlude: ports.recordPostlude }); },
  });
  const request = { workspaceId: 'bot', requestId: 'request', payloadHash: op.payloadHash };
  return { root, file, storage, writer, op, binding, journal, request, recorded: recorded.promise, starts: () => starts, expire: () => { current = false; } };
}
test('fresh dispatch runs once; duplicate start/query/reconcile do not replay a completed write or clear later draft text', async t => {
  const f = fixture(t); assert.equal(f.journal.start(f.request, f.binding).live, true); const running = f.journal.running('bot', 'request');
  assert.equal(f.journal.start(f.request, f.binding).repeated, true);
  f.storage.apply('bot', { type: 'edit', draftId: 'draft', revision: 1, writer: f.writer, text: 'later user input' });
  await running; const state = f.journal.query('bot', 'request'); assert.equal(state.operation.phase, 'settled'); assert.equal(state.operation.receipt.outcome, 'applied'); assert.equal(state.live, false);
  assert.equal((await f.journal.reconcile(f.request, f.binding)).observation, 'matches_proposed'); f.journal.start(f.request, f.binding);
  assert.equal(f.starts(), 1); assert.equal(f.storage.readDraft('bot', 'draft').draft.text, 'later user input'); assert.equal(readFileSync(f.file, 'utf8'), 'proposed');
});
test('a live post Hook does not leave an already durable file result displayed as running', async t => {
  const holdPost = deferred(), f = fixture(t, { holdPost }); f.journal.start(f.request, f.binding); const running = f.journal.running('bot', 'request');
  try {
    await f.recorded; const actual = f.journal.query('bot', 'request');
    assert.equal(actual.hasActualResult, true); assert.equal(actual.operation.phase, 'settled'); assert.equal(actual.operation.receipt.outcome, 'applied'); assert.equal(actual.live, true); assert.equal(actual.governance, 'pending');
    assert.equal(f.journal.cancel(f.request, f.binding).requested, false);
  } finally { holdPost.resolve(); await running; }
  assert.equal(f.journal.query('bot', 'request').governance, 'recorded');
});
test('missing original result cannot be converted into success merely because file bytes match the proposal', async t => {
  const f = fixture(t, { rawFailure: true }); f.journal.start(f.request, f.binding); await f.journal.running('bot', 'request');
  assert.equal(readFileSync(f.file, 'utf8'), 'proposed'); const reconciled = await f.journal.reconcile(f.request, f.binding);
  assert.equal(reconciled.operation.phase, 'uncertain'); assert.equal(reconciled.observation, 'matches_proposed'); assert.equal(reconciled.hasActualResult, false);
  assert.equal(f.journal.start(f.request, f.binding).repeated, true); assert.equal(f.starts(), 1);
});
test('actual source change prevents dispatch before Runtime construction', async t => {
  const holdPost = deferred(), f = fixture(t, { holdPost }); f.expire(); assert.equal(f.journal.start(f.request, f.binding).code, 'RESOURCE_EDIT_SOURCE_CHANGED'); assert.equal(f.starts(), 0); assert.equal(readFileSync(f.file, 'utf8'), 'base');
});

test('a lost persistence acknowledgement is reconciled against the original committed fact without replay', async t => {
  const f = fixture(t, { rawFailure: 'ack' }); f.journal.start(f.request, f.binding); await f.journal.running('bot', 'request');
  const state = await f.journal.reconcile(f.request, f.binding);
  assert.equal(state.hasActualResult, true); assert.equal(state.operation.phase, 'settled'); assert.equal(state.operation.receipt.outcome, 'applied');
  assert.equal(state.governance, 'pending'); assert.equal(state.observation, 'matches_proposed');
  assert.equal(f.journal.start(f.request, f.binding).repeated, true); assert.equal(f.starts(), 1);
});


test('explicitly withdrawing a prepared intent never creates a ToolCall or discards the saved draft', t => {
  const f = fixture(t); const stopped = f.journal.cancel(f.request, f.binding);
  assert.equal(stopped.operation.phase, 'settled'); assert.equal(stopped.operation.receipt.outcome, 'cancelled'); assert.equal(stopped.operation.receipt.toolCallId, undefined);
  assert.equal(f.journal.start(f.request, f.binding).repeated, true); assert.equal(f.starts(), 0); assert.equal(readFileSync(f.file, 'utf8'), 'base'); assert.equal(f.storage.readDraft('bot', 'draft').draft.text, 'proposed');
});
