import assert from 'node:assert/strict';
import test from 'node:test';
import { confirmedDelivery, normalizeDeliveryBinding } from './deliveryBindingState.ts';
import { createDocumentSessionState, createDocumentTabSession, normalizeDocumentSessionState, openDocumentTab } from './documentSessionState.ts';
const binding = { evidenceRef: 'tool-result://delivery', artifactRef: 'file:///project/a.md' };
const reference = { workspaceId: 'bot', path: '/project/a.md', task: { sessionId: 'session', planId: 'plan' } };
const delivery = { ...binding, kind: 'file' as const, label: 'a.md', reference };
test('a restored binding needs fresh host ownership, exact path and task; current content alone proves no history', () => {
  const result = { ok: false, evidenceRef: binding.evidenceRef, deliveryStatus: 'available' as const, deliveries: [delivery] };
  assert.equal(confirmedDelivery(result, binding, reference), delivery);
  for (const current of [{ ...reference, workspaceId: 'other' }, { ...reference, path: '/project/same-name.md' }, { ...reference, task: undefined },
    { ...reference, task: { sessionId: 'session', planId: 'other' } }]) assert.equal(confirmedDelivery(result, binding, current), undefined);
  assert.equal(confirmedDelivery({ ...result, deliveryStatus: 'scope_denied' }, binding, reference), undefined);
  assert.equal(confirmedDelivery({ ...result, evidenceRef: 'other' }, binding, reference), undefined);
  assert.equal(confirmedDelivery({ ok: true }, binding, reference), undefined); // old service does not confirm the new association
});
test('plain file and different delivery records keep separate tab identities and survive normalization without copied content', () => {
  let session = createDocumentSessionState();
  for (const provenance of [undefined, binding, { ...binding, evidenceRef: 'tool-result://another' }]) {
    session = openDocumentTab(session, createDocumentTabSession(reference.path, { reference, delivery: provenance }));
  }
  assert.equal(session.tabs.length, 3);
  const restored = normalizeDocumentSessionState(JSON.parse(JSON.stringify(session))); assert.equal(restored.tabs.length, 3);
  assert.deepEqual(restored.tabs[1].delivery, binding); assert.equal('summary' in restored.tabs[1], false);
  assert.equal(normalizeDocumentSessionState({ tabs: [{ ...session.tabs[1], delivery: { evidenceRef: '../secret', artifactRef: 'a' } }] }).tabs.length, 0);
  assert.equal(normalizeDeliveryBinding(null), undefined);
});
