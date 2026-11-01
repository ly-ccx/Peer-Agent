import test from 'node:test';
import assert from 'node:assert/strict';
import { intentDeliveredReplyRefs, intentReplyRefsProveDelivery } from './intent-reply-bindings.mjs';

test('historical delivery reuse is goal/version-bound and cannot skip a newly asked user answer', () => {
  const work = { workId: 'g', intentCoordination: { goalRevision: 2, revision: 3, decision: { operationId: 'return', sourceInputIds: [],
    disposition: { kind: 'return', replyRef: 'reservation' } }, coverage: [], review: { sources: [{ sessionId: 's', sourceRevision: 'current' }] } } };
  const message = { id: 'actual', content: 'Verified result', meta: { intentScopes: [{ workId: 'g', goalRevision: 1 }], sessionStates: [{ sessionId: 's', sourceRevision: 'current', status: 'accepted' }] } };
  const state = { deliveries: { actual: { message, state: 'delivered' } } };
  assert.deepEqual(intentDeliveredReplyRefs(state, work), []);
  message.meta.intentScopes[0].goalRevision = 2; assert.deepEqual(intentDeliveredReplyRefs(state, work), ['actual']);
  work.intentCoordination.decision.sourceInputIds = ['fresh-question']; assert.deepEqual(intentDeliveredReplyRefs(state, work), []);
  message.meta.intentBindings = [{ workId: 'g', goalRevision: 2, intentRevision: 3, decisionRef: 'return', replyRef: 'reservation' }];
  assert.equal(intentReplyRefsProveDelivery(state, work, ['actual']), true);
  message.meta.sessionStates[0].sourceRevision = 'old'; assert.equal(intentReplyRefsProveDelivery(state, work, ['actual']), false);
  state.deliveries.actual.state = 'prepared'; assert.deepEqual(intentDeliveredReplyRefs(state, work), []);
});
