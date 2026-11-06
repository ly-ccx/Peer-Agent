import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelRoutingView } from '../../../preload/contracts/bootstrapPreloadApi';
import { readRoutingDraft, editRoutingDraft, routingDraftPatch } from './routingDraft.ts';
const view: ModelRoutingView = { providers: [], singleModel: false, routing: { tiers: { strong: { primary: 'a', fallbacks: ['b'] } }, roles: {}, verifierPreferDifferentFamily: true, roleSpendCaps: { verifier: 2 } } };
test('routing writes contain only edited fields and explicit cap removal', () => {
  const saved = readRoutingDraft(view);
  const draft = editRoutingDraft(saved, { tiers: { strong: { primary: 'b', fallbacks: ['a'] } }, roleSpendCaps: { verifier: null } });
  assert.deepEqual(routingDraftPatch(draft, saved), { tiers: { strong: { primary: 'b', fallbacks: ['a'] } }, roleSpendCaps: { verifier: null } });
  assert.deepEqual(view.routing.tiers.strong, { primary: 'a', fallbacks: ['b'] });
});
test('invalid spend edits are retained locally and rejected before a host patch', () => {
  const saved = readRoutingDraft(view), draft = { ...saved, caps: { ...saved.caps, verifier: '-1' } };
  assert.throws(() => routingDraftPatch(draft, saved), /INVALID_SPEND_CAP/);
  assert.equal(draft.caps.verifier, '-1');
});
