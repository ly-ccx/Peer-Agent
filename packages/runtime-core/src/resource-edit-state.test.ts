import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { emptyResourceEditState, reduceResourceEdit, recoverResourceEditState, resourceEditManifest, type ResourceEditEvent, type ResourceEditState } from './resource-edit-state.ts';
const hashText = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const target = { recipient: { workspaceId: 'bot', conversationId: 'main' }, reference: { workspaceId: 'bot', path: '/repo/doc.md' }, base: { resourceId: hashText('identity'), contentVersion: hashText('base') } };
const ports = { hashText, now: () => '2026-10-27T00:00:00.000Z' };
const view = { viewId: 'view', windowId: 'window', generation: 1, token: 'token' };
function fixture() {
  let state = emptyResourceEditState('bot', 'host-a');
  const apply = (event: ResourceEditEvent) => { const result = reduceResourceEdit(state, event, ports); if (result.ok) state = result.state; return result; };
  const opened = apply({ type: 'open', id: 'draft', target, baseText: 'base' }); assert.equal(opened.ok, true);
  const acquired = apply({ type: 'acquire', draftId: 'draft', writer: view }); assert.equal(acquired.ok, true);
  if (!acquired.ok || !acquired.value.writer) throw Error('fixture');
  let writer = acquired.value.writer;
  const edit = (text: string) => apply({ type: 'edit', draftId: 'draft', revision: state.drafts[0]!.revision, writer, text });
  const reserve = (requestId = 'request') => apply({ type: 'reserve', requestId, draftId: 'draft', revision: state.drafts[0]!.revision, writer, providerId: 'runtime.file', proposedVersion: hashText(state.drafts[0]!.text) });
  return { apply, edit, reserve, state: () => state, writer: () => writer, replaceState: (next: ResourceEditState) => { state = next; }, replaceWriter: (next: typeof writer) => { writer = next; } };
}
test('reopening same base retains user text; different bases stay separate and stale CAS cannot overwrite later input', () => {
  const h = fixture(); h.edit('user text');
  const reopen = h.apply({ type: 'open', id: 'another', target, baseText: 'base' }); assert.equal(reopen.ok && reopen.value.draft?.text, 'user text'); assert.equal(h.state().drafts.length, 1);
  const changedTarget = { ...target, base: { ...target.base, contentVersion: hashText('new base') } };
  assert.equal(h.apply({ type: 'open', id: 'new-base', target: changedTarget, baseText: 'new base' }).ok, true);
  assert.equal(h.state().drafts[0]!.baseText, 'base'); assert.equal(h.state().drafts[0]!.text, 'user text');
  const stale = h.apply({ type: 'edit', draftId: 'draft', revision: 0, writer: h.writer(), text: 'stale' }); assert.equal(!stale.ok && stale.code, 'RESOURCE_EDIT_DRAFT_CONFLICT');
});
test('writer takeover invalidates late saves/releases; lease metadata is never persisted across restart', () => {
  const h = fixture(), nextView = { ...view, viewId: 'another-view', token: 'another-token' };
  const busy = h.apply({ type: 'acquire', draftId: 'draft', writer: nextView }); assert.equal(!busy.ok && busy.code, 'RESOURCE_EDIT_WRITER_BUSY');
  const taken = h.apply({ type: 'acquire', draftId: 'draft', writer: nextView, takeover: true }); assert.equal(taken.ok, true);
  assert.equal(!h.edit('late').ok, true); assert.equal(h.apply({ type: 'release', draftId: 'draft', writer: h.writer() }).ok, false);
  const manifest = resourceEditManifest(h.state()); assert.equal('writers' in manifest, false); assert.equal('hostEpoch' in manifest, false);
  const restored = recoverResourceEditState(manifest, 'bot', 'host-b', hashText)!; assert.equal(restored.writers.length, 0); assert.equal(restored.drafts[0]!.text, 'base');
});
test('stable reserve is not execution, new start happens once, different payload for same ID cannot overwrite the operation', () => {
  const h = fixture(); h.edit('proposed'); const reserve = h.reserve(); assert.equal(reserve.ok && reserve.value.execute, false);
  assert.equal(h.reserve().ok, true); assert.equal(h.state().operations.length, 1);
  const op = h.state().operations[0]!;
  const started = h.apply({ type: 'start', requestId: op.requestId, payloadHash: op.payloadHash }); assert.equal(started.ok && started.value.execute, true);
  const repeated = h.apply({ type: 'start', requestId: op.requestId, payloadHash: op.payloadHash }); assert.equal(repeated.ok && repeated.value.execute, false);
  h.edit('later input'); const conflict = h.reserve(); assert.equal(!conflict.ok && conflict.code, 'RESOURCE_EDIT_ID_CONFLICT');
  assert.equal(h.state().operations[0]!.proposedVersion, hashText('proposed'));
});
test('crashed running operation becomes uncertain and cannot be auto-started; actual receipt is idempotent without clearing new draft text', () => {
  const h = fixture(); h.edit('proposed'); h.reserve(); const op = h.state().operations[0]!;
  h.apply({ type: 'start', requestId: op.requestId, payloadHash: op.payloadHash }); h.edit('later input');
  const recovered = recoverResourceEditState(resourceEditManifest(h.state()), 'bot', 'host-b', hashText)!; h.replaceState(recovered);
  assert.equal(recovered.operations[0]!.phase, 'uncertain');
  const retry = h.apply({ type: 'start', requestId: op.requestId, payloadHash: op.payloadHash }); assert.equal(!retry.ok && retry.code, 'RESOURCE_EDIT_RESULT_UNCERTAIN');
  const receipt = { outcome: 'applied' as const, observedVersion: op.proposedVersion, toolCallId: 'actual-call', evidenceRef: 'evidence://actual' };
  assert.equal(h.apply({ type: 'settle', requestId: op.requestId, receipt }).ok, true);
  const repeated = h.apply({ type: 'settle', requestId: op.requestId, receipt }); assert.equal(repeated.ok && repeated.persist, false);
  assert.equal(h.state().drafts[0]!.text, 'later input');
  const conflict = h.apply({ type: 'settle', requestId: op.requestId, receipt: { outcome: 'failed' } }); assert.equal(!conflict.ok && conflict.code, 'RESOURCE_EDIT_RECEIPT_CONFLICT');
});
test('future/corrupt manifests and forged base or operation payload hash are refused without deleting old data', () => {
  const h = fixture(); const badBase = h.apply({ type: 'open', id: 'bad', target, baseText: 'different' }); assert.equal(badBase.ok, false);
  h.reserve(); const manifest = resourceEditManifest(h.state());
  assert.equal(recoverResourceEditState({ ...manifest, schemaVersion: 2 }, 'bot', 'new-host', hashText), undefined);
  assert.equal(recoverResourceEditState({ ...manifest, operations: [{ ...manifest.operations[0], payloadHash: hashText('forged') }] }, 'bot', 'new-host', hashText), undefined);
  assert.equal(recoverResourceEditState(manifest, 'other-bot', 'new-host', hashText), undefined);
  assert.equal(h.state().drafts.length, 1);
});
test('discard never forgets operation identity or allows the same draft ID to be repurposed for another resource', () => {
  const h = fixture(); h.reserve(); const op = h.state().operations[0]!;
  const beforeStart = h.apply({ type: 'discard', draftId: 'draft', revision: 0, writer: h.writer() }); assert.equal(!beforeStart.ok && beforeStart.code, 'RESOURCE_EDIT_OPERATION_PENDING');
  h.apply({ type: 'start', requestId: op.requestId, payloadHash: op.payloadHash });
  h.apply({ type: 'settle', requestId: op.requestId, receipt: { outcome: 'cancelled' } });
  assert.equal(h.apply({ type: 'discard', draftId: 'draft', revision: 0, writer: h.writer() }).ok, true);
  assert.equal(h.state().operations.length, 1); assert.equal(h.state().drafts.length, 0);
  const repurpose = h.apply({ type: 'open', id: 'draft', target: { ...target, reference: { ...target.reference, path: '/repo/another.md' } }, baseText: 'base' });
  assert.equal(!repurpose.ok && repurpose.code, 'RESOURCE_EDIT_ID_CONFLICT');
});
test('explicit archival frees active operation slots but preserves request and draft identities for every retry', () => {
  const h = fixture(); h.reserve(); const op = h.state().operations[0]!;
  const blocked = h.apply({ type: 'archive', requestId: op.requestId }); assert.equal(!blocked.ok && blocked.code, 'RESOURCE_EDIT_OPERATION_PENDING');
  h.apply({ type: 'start', requestId: op.requestId, payloadHash: op.payloadHash }); h.apply({ type: 'settle', requestId: op.requestId, receipt: { outcome: 'failed' } });
  assert.equal(h.apply({ type: 'archive', requestId: op.requestId }).ok, true); assert.equal(h.state().operations.length, 0); assert.equal(h.state().retiredOperations.length, 1);
  const duplicate = h.reserve(); assert.equal(duplicate.ok && duplicate.value.operation?.phase, 'settled');
  const start = h.apply({ type: 'start', requestId: op.requestId, payloadHash: op.payloadHash }); assert.equal(start.ok && start.value.execute, false);
  const recovered = recoverResourceEditState(resourceEditManifest(h.state()), 'bot', 'host-c', hashText)!; assert.equal(recovered.retiredOperations[0]!.receipt?.outcome, 'failed');
});

test('an unconfirmed real attempt becomes uncertain without replay and cannot erase a later applied result or draft text', () => {
  const h = fixture(); h.edit('proposal'); const reserved = h.reserve(); assert.ok(reserved.ok && reserved.value.operation);
  const payloadHash = reserved.value.operation.payloadHash;
  assert.equal(h.apply({ type: 'uncertain', requestId: 'request', payloadHash }).ok, false);
  h.apply({ type: 'start', requestId: 'request', payloadHash }); h.edit('later input');
  assert.equal(h.apply({ type: 'uncertain', requestId: 'request', payloadHash }).ok, true);
  assert.equal(h.state().operations[0]?.phase, 'uncertain'); assert.equal(h.state().drafts[0]?.text, 'later input');
  const replay = h.apply({ type: 'start', requestId: 'request', payloadHash }); assert.equal(!replay.ok && replay.code, 'RESOURCE_EDIT_RESULT_UNCERTAIN');
  assert.equal(h.apply({ type: 'settle', requestId: 'request', receipt: { outcome: 'applied', toolCallId: 'actual-call', evidenceRef: 'tool-result://actual-call', observedVersion: hashText('proposal') } }).ok, true);
  h.apply({ type: 'uncertain', requestId: 'request', payloadHash }); assert.equal(h.state().operations[0]?.phase, 'settled'); assert.equal(h.state().drafts[0]?.text, 'later input');
});

test('only a never-started prepared intent may be withdrawn without inventing an execution result', () => {
  const h = fixture(), saved = h.reserve(); assert.ok(saved.ok && saved.value.operation); const payloadHash = saved.value.operation.payloadHash;
  const withdrawn = h.apply({ type: 'withdraw', requestId: 'request', payloadHash }); assert.ok(withdrawn.ok); assert.equal(h.state().operations[0]?.receipt?.outcome, 'cancelled'); assert.equal(h.state().operations[0]?.receipt?.toolCallId, undefined);
  const restarted = h.apply({ type: 'start', requestId: 'request', payloadHash }); assert.ok(restarted.ok); assert.equal(restarted.value.execute, false); assert.equal(h.state().operations[0]?.phase, 'settled');
  const running = fixture(), next = running.reserve(); assert.ok(next.ok && next.value.operation); const hash = next.value.operation.payloadHash; running.apply({ type: 'start', requestId: 'request', payloadHash: hash });
  assert.equal(running.apply({ type: 'withdraw', requestId: 'request', payloadHash: hash }).ok, false); assert.equal(running.state().operations[0]?.phase, 'running');
});
test('another nonce cannot replay an unsettled same-base write; only an explicit separate version can form an independent edit after uncertainty', () => {
  const h = fixture(), first = h.reserve(); assert.ok(first.ok && first.value.operation); const original = first.value.operation;
  assert.equal(h.reserve().ok, true);
  for (const phase of ['prepared', 'running', 'uncertain'] as const) {
    if (phase === 'running') h.apply({ type: 'start', requestId: original.requestId, payloadHash: original.payloadHash });
    if (phase === 'uncertain') h.apply({ type: 'uncertain', requestId: original.requestId, payloadHash: original.payloadHash });
    const next = h.reserve(`another-${phase}`); assert.equal(!next.ok && next.code, 'RESOURCE_EDIT_OPERATION_PENDING');
  }
  const otherTarget = { ...target, base: { ...target.base, contentVersion: hashText('external') } };
  assert.equal(h.apply({ type: 'open', id: 'separate', target: otherTarget, baseText: 'external' }).ok, true);
  const acquired = h.apply({ type: 'acquire', draftId: 'separate', writer: { viewId: 'new-view', windowId: 'new-window', generation: 1, token: 'new-token' } }); assert.ok(acquired.ok && acquired.value.writer);
  const reserve = { type: 'reserve' as const, requestId: 'separate-request', draftId: 'separate', revision: 0, writer: acquired.value.writer, providerId: 'runtime.file', proposedVersion: hashText('external') };
  assert.equal(h.apply(reserve).ok, true);
  assert.equal(h.state().operations.find(op => op.requestId === original.requestId)?.phase, 'uncertain');
  assert.equal(h.state().operations.find(op => op.requestId === reserve.requestId)?.target.base.contentVersion, hashText('external'));
});
