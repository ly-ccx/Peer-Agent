import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApprovalStore } from '@peer-agent/runtime-node';
import { RESOURCE_FILE_REPLACE_PROVIDER } from '@peer-agent/protocol';
import { createResourceEditStorage } from '../../../../packages/runtime-node/src/project-agent/resource-edit-storage.mjs';
import { createResourceEditApplicationService } from './resource-edit-application-service.mjs';
import { createResourceEditSources } from './resource-edit-sources.mjs';
import { createResourceEditSubmissionHost } from './resource-edit-submission-host.mjs';
const hash = text => `sha256:${createHash('sha256').update(text).digest('hex')}`;
async function fixture(t, { preDecision = 'allow' } = {}) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'peer-human-submission-'))), file = path.join(root, 'a.md'); writeFileSync(file, 'base');
  const sender = new EventEmitter(), other = new EventEmitter(); for (const actual of [sender, other]) actual.isDestroyed = () => false;
  const resourceId = hash(file), observed = { resourceId, contentVersion: hash('base') }; let canRead = true, owner = 'main', sequence = 0;
  const waiters = new Set(), notify = () => { sequence++; for (const wake of [...waiters]) wake(); };
  const getRole = actual => [sender, other].includes(actual) ? 'main' : null, getOwner = () => ({ conversationId: owner });
  const sources = createResourceEditSources({ getRole, getOwner, resourceWindows: {}, fileAccess: { async readFile({ documentReference: ref }) {
    if (!canRead) return { ok: false, status: 'scope_denied' }; if (ref.path !== file) return { ok: false, status: 'source_changed' };
    const base = { ok: true, resolvedPath: file, resolvedFrom: root, identity: { resourceId } };
    if (ref.metadataOnly) return { ...base, metadataOnly: true };
    const content = readFileSync(file, 'utf8'), observation = { resourceId, contentVersion: hash(content) };
    if (ref.expectedObservation && (ref.expectedObservation.resourceId !== resourceId || ref.expectedObservation.contentVersion && ref.expectedObservation.contentVersion !== observation.contentVersion)) return { ok: false, status: 'version_changed' };
    return { ...base, content, observation };
  } } });
  const storage = createResourceEditStorage({ rootDir: path.join(root, 'data') });
  const edits = createResourceEditApplicationService({ storage, getRole, getOwner, getWindowId: actual => actual === sender ? 'window-main' : 'window-other',
    readSource: sources.read, isSourceCurrent: sources.isCurrent, canReadRetained: sources.canReadRetained, notify });
  const engine = createResourceEditSubmissionHost({ edits, storage, sources, sessionStore: { getSession: () => ({ locale: 'en-US' }) },
    authority: { read: () => ({ ok: true, policy: { workspaceId: 'bot', conversationId: 'main', accessLevel: 'ask_before_local', revision: 1 } }) },
    approvalStore: createApprovalStore({ rootDir: path.join(root, 'approvals') }), userDataPath: root,
    createHooks: () => ({ runPreToolUse: async () => preDecision === 'allow' ? [] : [{ event: 'PreToolUse', decision: preDecision, reason: 'Review the local Hook request.' }], runPostToolUse: async () => [] }) });
  t.after(async () => { await engine.dispose(); edits.dispose(); storage.close(); rmSync(root, { recursive: true, force: true }); });
  const opened = await edits.open(sender, { requestId: 'open', source: { kind: 'document', reference: { workspaceId: 'bot', path: file }, observed } }); assert.equal(opened.ok, true);
  const acquired = await edits.acquire(sender, { handle: opened.handle }); assert.equal(acquired.ok, true);
  assert.equal((await edits.save(sender, { handle: opened.handle, writer: acquired.writer, revision: 0, text: 'proposed' })).ok, true);
  const request = { handle: opened.handle, writer: acquired.writer, revision: 1, requestId: 'submission' }, operationRequest = { handle: opened.handle, requestId: 'submission' };
  async function waitFor(predicate, observedRequest = operationRequest) {
    for (let attempt = 0; attempt < 32; attempt++) {
      const before = sequence, state = await engine.submissions.operationStatus(sender, observedRequest); assert.equal(state.ok, true);
      if (predicate(state)) return state; if (sequence !== before) continue;
      await new Promise((resolve, reject) => {
        const done = () => { clearTimeout(timer); waiters.delete(done); resolve(); };
        const timer = setTimeout(() => { waiters.delete(done); reject(Error('submission observation timed out')); }, 3000); waiters.add(done); if (sequence !== before) done();
      });
    }
    throw Error('submission did not reach the requested observed state');
  }
  const decide = (state, allow = true) => engine.submissions.decideSubmissionPermission(sender, { ...operationRequest, challengeId: state.permission.challengeId, argsDigest: state.permission.argsDigest, allow });
  return { file, sender, other, storage, edits, engine, request, operationRequest, waitFor, decide,
    denyScope: () => { canRead = false; }, replaceOwner: () => { owner = 'replacement'; } };
}
test('real submission waits for local permission, preserves later input, records actual facts, and never replays on duplicate or reconciliation', async t => {
  const f = await fixture(t), api = f.engine.submissions;
  assert.equal((await api.submit(f.sender, { ...f.request, content: 'injected body' })).ok, false);
  assert.equal((await api.submit(f.other, f.request)).ok, false);
  assert.equal((await api.submit(f.sender, f.request)).ok, true); const waiting = await f.waitFor(state => !!state.permission);
  assert.equal(readFileSync(f.file, 'utf8'), 'base'); assert.equal(waiting.operation.phase, 'running');
  assert.equal((await f.edits.save(f.sender, { handle: f.request.handle, writer: f.request.writer, revision: 1, text: 'later user input' })).ok, true);
  assert.equal((await f.decide(waiting)).ok, true); const applied = await f.waitFor(state => state.operation.phase === 'settled' && !state.live);
  assert.equal(readFileSync(f.file, 'utf8'), 'proposed'); assert.equal(applied.operation.receipt.outcome, 'applied'); assert.equal(applied.governance, 'recorded');
  assert.equal(f.storage.readDraft('bot', f.request.handle.draftId).draft.text, 'later user input');
  const submitted = await api.readSubmission(f.sender, f.operationRequest); assert.equal(submitted.ok, true); assert.equal(submitted.baseText, 'base'); assert.equal(submitted.text, 'proposed');
  assert.equal((await api.readSubmission(f.other, f.operationRequest)).ok, false);
  const actual = await api.readExecution(f.sender, f.operationRequest); assert.equal(actual.ok, true);
  assert.equal(actual.record.result.observation.observedVersion, hash('proposed')); assert.equal(actual.record.result.evidence.toolCallId, actual.record.call.toolCallId);
  assert.equal((await api.readExecution(f.other, f.operationRequest)).ok, false);
  writeFileSync(f.file, 'external later version'); assert.equal((await api.submit(f.sender, f.request)).operation.receipt.outcome, 'applied');
  const checked = await api.reconcileSubmission(f.sender, f.operationRequest); assert.equal(checked.observation, 'changed'); assert.equal(checked.operation.receipt.outcome, 'applied');
  assert.equal(readFileSync(f.file, 'utf8'), 'external later version');
  assert.equal(f.storage.cleanup('bot', [f.request.requestId]).ok, true); assert.equal((await api.readSubmission(f.sender, f.operationRequest)).code, 'RESOURCE_EDIT_BODY_CLEANED');
  assert.equal((await api.readExecution(f.sender, f.operationRequest)).ok, true);
  f.denyScope(); assert.equal((await api.readExecution(f.sender, f.operationRequest)).ok, false);
});
test('a recovered prepared intent is only observed by submit; continuation requires a separate explicit action', async t => {
  const f = await fixture(t), draft = f.storage.readDraft('bot', f.request.handle.draftId).draft;
  const reserved = f.storage.apply('bot', { type: 'reserve', draftId: draft.id, revision: 1, writer: f.request.writer, requestId: f.request.requestId,
    providerId: RESOURCE_FILE_REPLACE_PROVIDER, proposedVersion: hash(draft.text) }); assert.equal(reserved.ok, true);
  const observed = await f.engine.submissions.submit(f.sender, f.request); assert.equal(observed.operation.phase, 'prepared'); assert.equal(observed.live, false); assert.equal(readFileSync(f.file, 'utf8'), 'base');
  assert.equal((await f.engine.submissions.continueSubmission(f.sender, f.operationRequest)).ok, true); const waiting = await f.waitFor(state => !!state.permission);
  await f.decide(waiting); const applied = await f.waitFor(state => state.operation.phase === 'settled' && !state.live); assert.equal(applied.operation.receipt.outcome, 'applied');
});
test('scope withdrawn during permission blocks the actual Provider; cancellation settles from the original result without file effects', async t => {
  for (const action of ['scope', 'cancel']) {
    const f = await fixture(t), api = f.engine.submissions; await api.submit(f.sender, f.request); const waiting = await f.waitFor(state => !!state.permission);
    if (action === 'scope') { f.denyScope(); await f.decide(waiting); } else await api.cancelSubmission(f.sender, f.operationRequest);
    const ended = await f.waitFor(state => state.operation.phase === 'settled' && !state.live);
    assert.notEqual(ended.operation.receipt.outcome, 'applied'); assert.equal(ended.hasActualResult, true); assert.equal(readFileSync(f.file, 'utf8'), 'base');
    assert.equal(f.storage.inspect('bot').manifest.operations.length, 1);
  }
});
test('Hook approval denial records the actual prefixed Grant association and settles denied instead of uncertain', async t => {
  const f = await fixture(t, { preDecision: 'ask' }); await f.engine.submissions.submit(f.sender, f.request);
  const waiting = await f.waitFor(state => !!state.permission); assert.ok(waiting.permission.confirmation);
  assert.equal((await f.decide(waiting, false)).ok, true);
  const ended = await f.waitFor(state => state.operation.phase === 'settled' && !state.live);
  assert.equal(ended.operation.receipt.outcome, 'denied'); assert.equal(readFileSync(f.file, 'utf8'), 'base');
  const actual = await f.engine.submissions.readExecution(f.sender, f.operationRequest);
  assert.equal(actual.ok, true); assert.equal(actual.record.call.permissionCallId, 'chat-permission:resource-edit:submission');
  assert.equal(actual.record.grant.toolCallId, actual.record.call.toolCallId); assert.equal(actual.record.grant.granted, false);
});
test('an unknown old write cannot be retried under another nonce; an explicitly read different base permits a separate change without settling or replaying the old operation', async t => {
  const f = await fixture(t), old = f.storage.apply('bot', { type: 'reserve', draftId: f.request.handle.draftId, revision: 1, writer: f.request.writer,
    requestId: f.request.requestId, providerId: RESOURCE_FILE_REPLACE_PROVIDER, proposedVersion: hash('proposed') });
  f.storage.apply('bot', { type: 'start', requestId: old.operation.requestId, payloadHash: old.operation.payloadHash });
  f.storage.apply('bot', { type: 'uncertain', requestId: old.operation.requestId, payloadHash: old.operation.payloadHash });
  assert.equal((await f.engine.submissions.submit(f.sender, { ...f.request, requestId: 'same-base-retry' })).code, 'RESOURCE_EDIT_OPERATION_PENDING');
  writeFileSync(f.file, 'explicit new base');
  const opened = await f.edits.open(f.sender, { requestId: 'new-base-open', source: { kind: 'document', reference: { workspaceId: 'bot', path: f.file },
    observed: { resourceId: hash(f.file), contentVersion: hash('explicit new base') } } }); assert.equal(opened.ok, true);
  const acquired = await f.edits.acquire(f.sender, { handle: opened.handle }); assert.equal(acquired.ok, true);
  assert.equal((await f.edits.save(f.sender, { handle: opened.handle, writer: acquired.writer, revision: 0, text: 'independent change' })).ok, true);
  const next = { handle: opened.handle, requestId: 'independent-submission' };
  assert.equal((await f.engine.submissions.submit(f.sender, { ...next, writer: acquired.writer, revision: 1 })).ok, true);
  const waiting = await f.waitFor(state => !!state.permission, next);
  assert.equal((await f.engine.submissions.decideSubmissionPermission(f.sender, { ...next, challengeId: waiting.permission.challengeId, argsDigest: waiting.permission.argsDigest, allow: true })).ok, true);
  const applied = await f.waitFor(state => state.operation.phase === 'settled' && !state.live, next); assert.equal(applied.operation.receipt.outcome, 'applied');
  const original = f.storage.inspect('bot').manifest.operations.find(op => op.requestId === f.request.requestId);
  assert.equal(original.phase, 'uncertain'); assert.equal(f.storage.executionResult('bot', f.request.requestId).code, 'RESOURCE_EDIT_EXECUTION_MISSING');
  assert.equal(f.storage.operationText('bot', f.request.requestId).text, 'proposed'); assert.equal(readFileSync(f.file, 'utf8'), 'independent change');
});
test('same-window reopening restores the one pending challenge; a retired handle cannot approve it or create a second submission', async t => {
  const f = await fixture(t), api = f.engine.submissions; await api.submit(f.sender, f.request); const waiting = await f.waitFor(state => !!state.permission);
  assert.equal(f.edits.close(f.sender, f.request.handle).ok, true);
  const reopened = await f.edits.resume(f.sender, { requestId: 'reopened', workspaceId: 'bot', draftId: f.request.handle.draftId }); assert.equal(reopened.ok, true);
  const next = { handle: reopened.handle, requestId: f.request.requestId }, restored = await api.operationStatus(f.sender, next);
  assert.equal(restored.permission.challengeId, waiting.permission.challengeId); assert.equal(restored.permissionElsewhere, false);
  const decision = { challengeId: waiting.permission.challengeId, argsDigest: waiting.permission.argsDigest, allow: true };
  assert.equal((await api.decideSubmissionPermission(f.sender, { ...f.operationRequest, ...decision })).ok, false);
  assert.equal((await api.decideSubmissionPermission(f.sender, { ...next, ...decision })).ok, true);
  const applied = await f.waitFor(state => state.operation.phase === 'settled' && !state.live, next); assert.equal(applied.operation.receipt.outcome, 'applied');
  assert.equal(f.storage.inspect('bot').manifest.operations.length, 1); assert.equal(readFileSync(f.file, 'utf8'), 'proposed');
});
test('another actual window learns that authorization is elsewhere, cannot approve it, and can explicitly cancel the resource request', async t => {
  const f = await fixture(t), api = f.engine.submissions; await api.submit(f.sender, f.request); const waiting = await f.waitFor(state => !!state.permission);
  const opened = await f.edits.resume(f.other, { requestId: 'other-window', workspaceId: 'bot', draftId: f.request.handle.draftId }); assert.equal(opened.ok, true);
  const other = { handle: opened.handle, requestId: f.request.requestId }, state = await api.operationStatus(f.other, other);
  assert.equal(state.permission, null); assert.equal(state.permissionElsewhere, true);
  assert.equal((await api.decideSubmissionPermission(f.other, { ...other, challengeId: waiting.permission.challengeId, argsDigest: waiting.permission.argsDigest, allow: true })).ok, false);
  assert.equal(readFileSync(f.file, 'utf8'), 'base'); assert.equal((await api.cancelSubmission(f.other, other)).ok, true);
  const stopped = await f.waitFor(value => value.operation.phase === 'settled' && !value.live); assert.equal(stopped.operation.receipt.outcome, 'cancelled');
  assert.equal(readFileSync(f.file, 'utf8'), 'base');
});
