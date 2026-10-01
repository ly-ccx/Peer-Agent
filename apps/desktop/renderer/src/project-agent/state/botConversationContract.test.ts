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

test('ChatSurface 行数不变', () => {
  assert.equal(lineCount('chat/components/ChatSurface.tsx'), 3306);
});

test('卡片动作只调用约定的 IPC', () => {
  const card = source('project-agent/conversation/CardView.tsx');
  assert.match(card, /projectAgentDecideApproval/);
  assert.match(card, /projectAgentSubmitInput/);
  assert.equal(card.includes('projectAgentDelete'), false);
  assert.equal(card.includes('projectAgentCreate'), false);
  assert.equal(card.includes('projectAgentUpdateProfile'), false);
  assert.equal(card.includes('child_process'), false);
  assert.equal(card.includes('conversationStore'), false);
  const calls = [...card.matchAll(/clientApi\.(\w+)/g)].map((match) => match[1]);
  assert.deepEqual(calls, [
    'projectAgentDecideApproval',
    'projectAgentSubmitInput',
    'projectAgentStartFamiliarize',
    'projectAgentConfirmResult',
    'projectAgentAcceptReadme',
    'projectAgentRetry',
  ]);
});
