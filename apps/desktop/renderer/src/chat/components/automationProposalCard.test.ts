import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const cardSource = readFileSync(new URL('./AutomationProposalCard.tsx', import.meta.url), 'utf8');
const surfaceSource = readFileSync(new URL('./ChatSurface.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../styles/chat-surface.css', import.meta.url), 'utf8');
const projectionSource = readFileSync(new URL('../../automations/automationChatProposal.ts', import.meta.url), 'utf8');

test('automation proposal stays a conversation-scoped structured card', () => {
  assert.match(surfaceSource, /selectAutomationChatProposal\(convState\.automationCreateContext\)/);
  assert.match(projectionSource, /return context\?\.activeProposal \?\? null/);
  assert.match(surfaceSource, /<VirtualChatTurnList[\s\S]*<AutomationProposalCard/);
  assert.doesNotMatch(cardSource, /role=['"]assistant['"]/);
  assert.doesNotMatch(cardSource, /contentEditable|<textarea|<input/);
});

test('proposal actions use the governed action port with stale-card identity', () => {
  assert.match(surfaceSource, /clientApi\.automationProposalAct\([\s\S]*buildAutomationProposalActionRequest\(conversationId, automationProposal, action\)/);
  assert.match(projectionSource, /proposalId: proposal\.proposalId/);
  assert.match(projectionSource, /fingerprint: proposal\.fingerprint/);
  assert.match(cardSource, /act\('cancel'\)/);
  assert.match(cardSource, /act\('confirm'\)/);
  assert.match(cardSource, /if \(pendingAction\) return/);
  assert.equal(cardSource.match(/disabled=\{Boolean\(pendingAction\)\}/g)?.length, 2);
});

test('proposal lifecycle renders real terminal facts without claiming cancelled work succeeded', () => {
  assert.match(cardSource, /hasCreationReceipt && proposal\.receipt/);
  assert.match(projectionSource, /proposal\.status === 'created' && Boolean\(proposal\.receipt\)/);
  assert.match(cardSource, /proposal\.receipt\.automationName/);
  assert.match(cardSource, /proposal\.receipt\.automationId/);
  assert.match(cardSource, /proposal\.status === 'cancelled'/);
  assert.match(cardSource, /proposal\.status === 'failed'/);
  assert.match(cardSource, /proposal\.error/);
});

test('proposal card has token-based responsive and reduced-motion styles', () => {
  assert.match(styles, /\.automation-proposal-card \{/);
  assert.match(styles, /background: var\(--paper-sheet\)/);
  assert.match(styles, /@media \(max-width: 680px\)[\s\S]*\.automation-proposal-card-facts/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none/);
});
