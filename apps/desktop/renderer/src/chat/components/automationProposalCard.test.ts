import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const cardSource = readFileSync(new URL('./AutomationProposalCard.tsx', import.meta.url), 'utf8');
const surfaceSource = readFileSync(new URL('./ChatSurface.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../styles/chat-surface.css', import.meta.url), 'utf8');
const projectionSource = readFileSync(new URL('../../automations/automationChatProposal.ts', import.meta.url), 'utf8');

test('automation proposal stays a conversation-scoped structured card', () => {
  assert.match(surfaceSource, /selectAutomationChatProposal\(convState\.automationCreateContext\)/);
  // Terminal proposals are filtered out of the footer; open proposals still come from activeProposal.
  assert.match(projectionSource, /const proposal = context\?\.activeProposal \?\? null/);
  assert.match(projectionSource, /proposal\.status === 'created' \|\| proposal\.status === 'cancelled'\) return null/);
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

test('proposal card refuses flex-shrink so the thread cannot crush it into a hairline', () => {
  // .chat-thread is a column flex container; the proposal card sits after
  // VirtualChatTurnList (flex:1). overflow:hidden would auto min-height:0 and
  // default flex-shrink:1 would collapse the card to a border-only hairline.
  assert.match(styles, /\.automation-proposal-card \{[\s\S]*?flex-shrink:\s*0/);
});

test('terminal automation proposals default to compact collapse path', () => {
  // Created / cancelled must not keep the full decision body permanently open.
  assert.match(projectionSource, /prefersCompact:\s*isTerminal/);
  assert.match(cardSource, /prefersCompact/);
  assert.match(cardSource, /const compact = prefersCompact && !expanded/);
  assert.match(cardSource, /is-compact/);
  assert.match(cardSource, /is-terminal/);
  assert.match(cardSource, /automation-proposal-card-toggle/);
  assert.match(cardSource, /automation-proposal-card-compact-summary/);
  assert.match(cardSource, /data-compact=\{compact \? 'true' : 'false'\}/);
  assert.match(styles, /\.automation-proposal-card\.is-compact/);
  assert.match(styles, /\.automation-proposal-card-compact-body/);
  assert.match(styles, /\.automation-proposal-card-toggle/);
});
