import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const rendererSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function source(relativePath: string): string {
  return readFileSync(path.join(rendererSrc, relativePath), 'utf8');
}

function lineCount(relativePath: string): number {
  const text = source(relativePath);
  if (!text) return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

test('ChatSurface 不超过原模块预算', () => {
  assert.ok(lineCount('chat/components/ChatSurface.tsx') <= 3306, '抽离逻辑可以减行，新增职责仍须放到独立模块');
});

test('卡片动作只调用约定的 IPC', () => {
  const card = source('project-agent/conversation/CardView.tsx');
  assert.match(card, /projectAgentDecideApproval/);
  assert.match(card, /inputRecoveryFor\(workspaceId\)\.send\(\{ text, answerTo, useDraft: false \}\)/);
  const input = source('project-agent/state/useInputRecovery.ts');
  assert.match(input, /submit: request => clientApi\.projectAgentSubmitInput\(request\)/);
  assert.equal(card.includes('projectAgentDelete'), false);
  assert.equal(card.includes('projectAgentCreate'), false);
  assert.equal(card.includes('projectAgentUpdateProfile'), false);
  assert.equal(card.includes('child_process'), false);
  assert.equal(card.includes('conversationStore'), false);
  const calls = [...card.matchAll(/clientApi\.(\w+)/g)].map((match) => match[1]);
  assert.deepEqual(calls, [
    'projectAgentReadConversation',
    'projectMemoryRestore',
    'projectAgentDecideApproval',
    'projectAgentStartFamiliarize',
    'projectAgentConfirmResult',
    'projectAgentAcceptReadme',
    'projectAgentRetry',
  ]);
});


test('conversation refresh includes latest host cards and queues changes during reads', () => {
  const hook=source('project-agent/state/useBotConversation.ts');
  assert.match(hook,/onProjectAgentChanged/);
  assert.match(hook,/createConversationRefresh/);
  assert.doesNotMatch(hook,/appendAfterTail/);
});
