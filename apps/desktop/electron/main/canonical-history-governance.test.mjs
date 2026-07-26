import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const mainSource = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
const rendererSource = readFileSync(
  new URL('../../renderer/src/chat/components/ChatSurface.tsx', import.meta.url),
  'utf8',
);
const tuiPersistenceSource = readFileSync(
  new URL('../../../tui/src/conversation-persistence.ts', import.meta.url),
  'utf8',
);

test('conversation send, restore, Goal Runner and TUI resume share the canonical history seam', () => {
  assert.match(mainSource, /projectConversationHistory\(persistedConversation\.messages\)/);
  assert.match(mainSource, /projectConversationHistory\(conversation\.messages\)/);
  assert.match(mainSource, /projectConversationHistory\(conv\.messages\)/);
  assert.match(tuiPersistenceSource, /projectConversationHistory\(messages\)/);
});

test('Renderer conversation send submits dispatch facts instead of provider history', () => {
  assert.doesNotMatch(rendererSource, /toApiMessages\(contextMessages\)/);
  assert.doesNotMatch(rendererSource, /chatSend\(\{\s*messages:/);
  assert.doesNotMatch(rendererSource, /buildConversationContinuityContext\(/);
  assert.match(
    rendererSource,
    /conversationsReplaceMessages\(\{\s*id:\s*conversationId,\s*messages:\s*serializeConversationMessages\(\[\.\.\.contextMessages,\s*newAssistant\]\)/,
  );
});

test('legacy host-specific history projectors cannot return to production paths', () => {
  assert.doesNotMatch(mainSource, /function\s+toProjectionMessages\s*\(/);
  assert.doesNotMatch(mainSource, /function\s+toRuntimeMessages\s*\(/);
  assert.doesNotMatch(mainSource, /function\s+continuityContextFromMessages\s*\(/);
  assert.doesNotMatch(tuiPersistenceSource, /function\s+modelMessagesFromStored\s*\(/);
});
