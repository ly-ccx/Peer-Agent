import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const surfaceSource = readFileSync(new URL('../chat/components/ChatSurface.tsx', import.meta.url), 'utf8');
const cardSource = readFileSync(new URL('../chat/components/AutomationProposalCard.tsx', import.meta.url), 'utf8');
const projectionSource = readFileSync(new URL('./automationChatProposal.ts', import.meta.url), 'utf8');

test('chat flow projects conversation metadata into a structured proposal card', () => {
  assert.match(surfaceSource, /selectAutomationChatProposal\(convState\.automationCreateContext\)/);
  assert.match(surfaceSource, /<AutomationProposalCard/);
  assert.match(surfaceSource, /proposal=\{automationProposal\}/);
  assert.doesNotMatch(surfaceSource, /messages[^\n]*AutomationChatProposal/);
  assert.match(cardSource, /projectAutomationChatProposal\(proposal\)/);
});

test('confirm and cancel use the Automation IPC owner with proposal identity', () => {
  assert.match(surfaceSource, /clientApi\.automationProposalAct\(/);
  assert.match(surfaceSource, /buildAutomationProposalActionRequest\(conversationId, automationProposal, action\)/);
  assert.match(projectionSource, /proposalId: proposal\.proposalId/);
  assert.match(projectionSource, /fingerprint: proposal\.fingerprint/);
  assert.match(projectionSource, /action,/);
  assert.match(cardSource, /act\('cancel'\)/);
  assert.match(cardSource, /act\('confirm'\)/);
});

test('authoritative action results replace conversation proposal state and expose real receipts', () => {
  assert.match(surfaceSource, /applyAutomationProposalActionResult\(/);
  // Terminal confirm/cancel clear the footer card; non-terminal still keep activeProposal.
  assert.match(projectionSource, /activeProposal: terminal \? null : proposal/);
  assert.match(projectionSource, /status: proposal\.status/);
  assert.match(projectionSource, /proposal\.status === 'created' \|\| proposal\.status === 'cancelled'/);
  assert.match(cardSource, /hasCreationReceipt && proposal\.receipt/);
  assert.match(cardSource, /proposal\.receipt\.automationId/);
});

test('natural-language revisions stay in chat instead of a second proposal editor', () => {
  assert.match(cardSource, /Need changes\? Tell me below/);
  assert.doesNotMatch(cardSource, /<input|<textarea|contentEditable/);
});
