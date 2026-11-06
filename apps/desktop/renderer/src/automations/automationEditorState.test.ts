import assert from 'node:assert/strict';
import test from 'node:test';
import type { AutomationDefinition } from '@peer-agent/protocol';
import { automationEditorDrafts as store, blankDraft } from './automationEditorState.ts';

test('a pending save survives editor replacement and cannot be discarded or submitted again', () => {
  const key = 'pending-editor', draft = blankDraft('/workspace');
  const ticket = store.begin(key, draft, null);
  store.retain(key, { ...draft, prompt: 'new text' }, null); store.discard(key);
  assert.equal(store.get(key), ticket);
  assert.throws(() => store.begin(key, draft, null), /SAVE_PENDING/);
  store.finish(key, ticket, false);
  assert.equal(store.get(key)?.state, 'unconfirmed');
  assert.equal(store.get(key)?.draft, draft);
  store.reviewed(key); assert.equal(store.get(key)?.state, 'editing'); store.discard(key);
});

test('only the matching write can establish a receipt and a late receipt cannot clear a later draft', () => {
  const key = 'receipt-editor', draft = blankDraft('/workspace');
  const receipt = { automationId: 'actual', version: 2 } as AutomationDefinition;
  const old = store.begin(key, draft, null);
  store.finish(key, old, false); store.reviewed(key);
  store.retain(key, { ...draft, prompt: 'later edit' }, null);
  const later = store.get(key);
  store.finish(key, old, true, receipt);
  assert.equal(store.get(key), later);
  const current = store.begin(key, later!.draft, null);
  store.finish(key, current, true, receipt);
  assert.equal(store.get(key)?.definition, receipt);
  assert.equal(store.get(key)?.state, 'confirmed');
  assert.throws(() => store.begin(key, draft, null), /SAVE_PENDING/);
  store.discard(key);
});
