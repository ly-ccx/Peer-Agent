import assert from 'node:assert/strict';
import test from 'node:test';
import { approvalCardReceipt, cardDecisionKey } from './cardDecisionReceipt.ts';
import { readBotCards, type BotChatCard } from './botConversationState.ts';
const card: BotChatCard = { cardId: 'card:approval:a', kind: 'approval', content: 'read file', resolvedState: 'open', refs: { approvalId: 'a' }, actions: [{ id: 'allow' }] };
test('the actual expired/denied/cancelled/approved host state wins over the clicked Allow button', () => {
  for (const state of ['expired', 'denied', 'cancelled', 'approved']) {
    const receipt = approvalCardReceipt('ws', card, { ok: true, approval: { workspaceId: 'ws', approvalId: 'a', state } });
    assert.equal(receipt?.resolution?.state, state); assert.deepEqual(receipt?.actions, []);
  }
});
test('ok alone, wrong targets and nonterminal approvals cannot manufacture a receipt', () => {
  for (const result of [{ ok: true }, { approval: { workspaceId: 'other', approvalId: 'a', state: 'approved' } },
    { approval: { workspaceId: 'ws', approvalId: 'b', state: 'approved' } }, { approval: { workspaceId: 'ws', approvalId: 'a', state: 'stale' } }]) {
    assert.equal(approvalCardReceipt('ws', card, result), null);
  }
  assert.notEqual(cardDecisionKey(card), cardDecisionKey({ ...card, refs: { approvalId: 'changed' } }));
});
test('card decoding retains the approval identity needed to bind a factual receipt', () => {
  assert.equal(readBotCards([card])[0]?.refs?.approvalId, 'a');
});
